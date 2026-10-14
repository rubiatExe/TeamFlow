import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server.js';
import { z } from 'zod';

import { requestDocumentExtraction, type DocumentExtractionRequest } from '../../../lib/ai/document-processor-client.ts';
import { MAX_DOCUMENT_BYTES, ParserInputSchema } from '../../../lib/contracts/parser.ts';
import {
  finalizeProductionApplication,
  findUploadGrant,
  registerUploadGrant,
  releaseUploadGrant,
  reservePreview,
  verifyInvitation,
} from '../../../lib/db/production-application.ts';
import { createSignedResumeUpload, downloadResume } from '../../../lib/db/storage.ts';
import type { ApplicationSubmission } from '../../../lib/db/supabase.ts';
import { validateStoredResume, resumeExtension } from '../../../lib/domain/resume-file.ts';
import { extractResumePrefill } from '../../../lib/domain/resume-prefill.ts';
import { getRoleById, isRoleQuestionAnswerTypeValid, isRoleQuestionFailure } from '../../../lib/domain/roles.ts';
import {
  createDeadlineSignal,
  readBoundedJson,
  validateBoundedJsonRequestHeaders,
  RequestBodyDeadlineError,
  RequestBodyTooLargeError,
  UnsupportedJsonMediaTypeError,
} from '../../../lib/http/bounded-json.ts';
import { parseApplicationBearer, parseApplicationLinkToken } from '../../../lib/http/production-application-token.ts';
import { ApplicationRequestSchema, generateMarkdownFromSubmission } from './handler.ts';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

const UploadMetadataSchema = ParserInputSchema.pick({ fileName: true, mimeType: true })
  .extend({ size: z.number().int().min(1).max(MAX_DOCUMENT_BYTES) }).strict();
const UploadReferenceSchema = z.object({ uploadId: z.uuid() }).strict();
const ProductionApplicationSchema = ApplicationRequestSchema.omit({ candidateId: true, resume: true })
  .extend({
    uploadId: z.uuid(),
    basicInfo: ApplicationRequestSchema.shape.basicInfo.extend({
      phone: z.string().trim().min(7).max(40),
    }),
  }).strict();

type Dependencies = Readonly<{
  verifyInvitation: typeof verifyInvitation;
  registerUploadGrant: typeof registerUploadGrant;
  releaseUploadGrant: typeof releaseUploadGrant;
  findUploadGrant: typeof findUploadGrant;
  reservePreview: typeof reservePreview;
  finalizeApplication: typeof finalizeProductionApplication;
  createSignedUpload: typeof createSignedResumeUpload;
  downloadResume: typeof downloadResume;
  extractResume: (request: DocumentExtractionRequest) => Promise<{ markdown: string }>;
}>;

const defaults: Dependencies = {
  verifyInvitation,
  registerUploadGrant,
  releaseUploadGrant,
  findUploadGrant,
  reservePreview,
  finalizeApplication: finalizeProductionApplication,
  createSignedUpload: createSignedResumeUpload,
  downloadResume,
  extractResume: requestDocumentExtraction,
};

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: SECURITY_HEADERS });
}

function failure(code: string, message: string, status: number, retryable = false): NextResponse {
  return json({ success: false, error: { code, message, retryable } }, status);
}

async function boundedBody(request: NextRequest, maxBytes: number): Promise<unknown> {
  const deadline = createDeadlineSignal(5_000, request.signal);
  try {
    validateBoundedJsonRequestHeaders(request, maxBytes);
    return await readBoundedJson(request, maxBytes, { signal: deadline.signal, maxFrames: 128 });
  } finally {
    deadline.dispose();
  }
}

function bodyFailure(error: unknown): NextResponse {
  if (error instanceof RequestBodyTooLargeError) {
    return failure('REQUEST_TOO_LARGE', 'The application request is too large.', 413);
  }
  if (error instanceof RequestBodyDeadlineError) {
    return failure('REQUEST_TIMEOUT', 'The upload request took too long. Please try again.', 408, true);
  }
  if (error instanceof UnsupportedJsonMediaTypeError) {
    return failure('INVALID_REQUEST', 'Send a JSON request.', 415);
  }
  return failure('INVALID_REQUEST', 'The request is invalid.', 400);
}

async function authenticatedInvitation(request: NextRequest, dependencies: Dependencies) {
  const token = parseApplicationBearer(request.headers);
  if (!token) return null;
  return dependencies.verifyInvitation(token);
}

export function createProductionSessionGet(dependencies: Partial<Dependencies> = {}) {
  const services = { ...defaults, ...dependencies };
  return async function productionSessionGet(request: NextRequest): Promise<NextResponse> {
    const token = parseApplicationLinkToken(request.nextUrl.searchParams.get('token'));
    if (!token) return failure('INVALID_INVITATION', 'This application link is invalid or expired.', 401);
    try {
      const invitation = await services.verifyInvitation(token);
      if (!invitation || !getRoleById(invitation.roleId)) {
        return failure('INVALID_INVITATION', 'This application link is invalid or expired.', 401);
      }
      return json({
        success: true,
        session: {
          candidateName: invitation.candidateName ?? '',
          merchantName: invitation.merchantName,
          roleId: invitation.roleId,
        },
      });
    } catch {
      return failure('SERVICE_UNAVAILABLE', 'The application is temporarily unavailable.', 503, true);
    }
  };
}

export function createProductionResumeUploadPost(dependencies: Partial<Dependencies> = {}) {
  const services = { ...defaults, ...dependencies };
  return async function productionResumeUploadPost(request: NextRequest): Promise<NextResponse> {
    let invitation: Awaited<ReturnType<typeof verifyInvitation>>;
    try { invitation = await authenticatedInvitation(request, services); }
    catch { return failure('SERVICE_UNAVAILABLE', 'The upload service is temporarily unavailable.', 503, true); }
    if (!invitation) return failure('INVALID_INVITATION', 'This application link is invalid or expired.', 401);

    let raw: unknown;
    try { raw = await boundedBody(request, 2_048); }
    catch (error) { return bodyFailure(error); }
    const parsed = UploadMetadataSchema.safeParse(raw);
    const extension = parsed.success ? resumeExtension(parsed.data.mimeType, parsed.data.fileName) : null;
    if (!parsed.success || !extension) {
      return failure('INVALID_RESUME', 'Choose a PDF, JPG, or PNG résumé up to 10 MB.', 400);
    }

    const storagePath = `candidate-invitations/${invitation.id}/${randomUUID()}.${extension === 'jpeg' ? 'jpg' : extension}`;
    try {
      const registration = await services.registerUploadGrant(invitation.id, {
        storagePath,
        fileName: parsed.data.fileName,
        mimeType: parsed.data.mimeType,
        sizeBytes: parsed.data.size,
      });
      if (registration.status === 'limit') {
        return failure('UPLOAD_LIMIT', 'This link has reached its résumé upload limit. Contact the employer for a new link.', 429);
      }
      if (registration.status === 'unavailable') {
        return failure('UPLOAD_UNAVAILABLE', 'The résumé upload could not be prepared. Please try again.', 503, true);
      }
      const grant = registration.grant;
      const signedToken = await services.createSignedUpload(grant.storagePath);
      if (!signedToken) {
        await services.releaseUploadGrant(invitation.id, grant.id);
        return failure('UPLOAD_UNAVAILABLE', 'The résumé upload could not be prepared. Please try again.', 503, true);
      }
      return json({ success: true, upload: { id: grant.id, path: grant.storagePath, signedToken } });
    } catch {
      return failure('UPLOAD_UNAVAILABLE', 'The résumé upload could not be prepared. Please try again.', 503, true);
    }
  };
}

async function verifiedUpload(
  services: Dependencies,
  invitationId: string,
  uploadId: string,
) {
  const grant = await services.findUploadGrant(invitationId, uploadId);
  if (!grant) return null;
  const blob = await services.downloadResume(grant.storagePath);
  if (!blob) return null;
  const validated = await validateStoredResume(blob, grant);
  return validated ? { grant, ...validated } : null;
}

export function createProductionResumePreviewPost(dependencies: Partial<Dependencies> = {}) {
  const services = { ...defaults, ...dependencies };
  return async function productionResumePreviewPost(request: NextRequest): Promise<NextResponse> {
    let invitation: Awaited<ReturnType<typeof verifyInvitation>>;
    try { invitation = await authenticatedInvitation(request, services); }
    catch { return failure('SERVICE_UNAVAILABLE', 'The application is temporarily unavailable.', 503, true); }
    if (!invitation) return failure('INVALID_INVITATION', 'This application link is invalid or expired.', 401);

    let raw: unknown;
    try { raw = await boundedBody(request, 1_024); }
    catch (error) { return bodyFailure(error); }
    const parsed = UploadReferenceSchema.safeParse(raw);
    if (!parsed.success) return failure('INVALID_REQUEST', 'Choose an uploaded résumé.', 400);
    const role = getRoleById(invitation.roleId);
    if (!role) return failure('INVALID_INVITATION', 'This application link is invalid or expired.', 401);

    try {
      const upload = await verifiedUpload(services, invitation.id, parsed.data.uploadId);
      if (!upload) return failure('INVALID_RESUME', 'Upload a valid PDF, JPG, or PNG résumé.', 400);
      if (!await services.reservePreview(invitation.id, upload.grant.id)) {
        return failure('PREVIEW_LIMIT', 'Resume details have already been read several times. You can still edit the form and submit.', 429);
      }
      const extraction = await services.extractResume({
        bytes: upload.bytes,
        mimeType: upload.grant.mimeType,
        fileName: upload.grant.fileName,
        serviceUrl: process.env.OCR_SERVICE_URL || 'http://localhost:8000',
        token: process.env.OCR_SERVICE_TOKEN || '',
      });
      return json({ success: true, prefill: extractResumePrefill(extraction.markdown, role) });
    } catch (error) {
      console.warn('[Production Resume Preview] Extraction unavailable', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return failure('EXTRACTION_UNAVAILABLE', 'We could not read this résumé. Fill in the form yourself; it will still be attached.', 502, true);
    }
  };
}

export function createProductionApplicationPost(dependencies: Partial<Dependencies> = {}) {
  const services = { ...defaults, ...dependencies };
  return async function productionApplicationPost(request: NextRequest): Promise<NextResponse> {
    let invitation: Awaited<ReturnType<typeof verifyInvitation>>;
    try { invitation = await authenticatedInvitation(request, services); }
    catch { return failure('SERVICE_UNAVAILABLE', 'The application is temporarily unavailable.', 503, true); }
    if (!invitation) return failure('INVALID_INVITATION', 'This application link is invalid or expired.', 401);

    let raw: unknown;
    try { raw = await boundedBody(request, 64 * 1024); }
    catch (error) { return bodyFailure(error); }
    const parsed = ProductionApplicationSchema.safeParse(raw);
    if (!parsed.success || parsed.data.roleId !== invitation.roleId) {
      return failure('INVALID_REQUEST', 'Please review the required application fields.', 400);
    }
    const body = parsed.data;
    const role = getRoleById(invitation.roleId);
    if (!role) return failure('INVALID_INVITATION', 'This application link is invalid or expired.', 401);
    const expected = new Set(role.questions.knockout.map(question => question.id));
    if (Object.keys(body.knockoutAnswers).length !== expected.size
      || Object.keys(body.knockoutAnswers).some(id => !expected.has(id))
      || role.questions.knockout.some(question => {
        const answer = body.knockoutAnswers[question.id];
        return answer === undefined || !isRoleQuestionAnswerTypeValid(question, answer);
      })) {
      return failure('INVALID_REQUEST', 'Answer every required role question.', 400);
    }
    const failedKnockouts = role.questions.knockout.filter(question =>
      isRoleQuestionFailure(question, body.knockoutAnswers[question.id]));
    const passed = failedKnockouts.length === 0;

    const submission: ApplicationSubmission = {
      role_id: invitation.roleId,
      basic_info: {
        full_name: body.basicInfo.fullName,
        email: body.basicInfo.email,
        phone: body.basicInfo.phone,
        city: body.basicInfo.city,
      },
      knockout_answers: body.knockoutAnswers,
      profile: {
        preferred_shifts: body.profile.preferredShifts,
        days_available: body.profile.daysAvailable,
        start_date: body.profile.startDate,
        transportation: body.profile.transportation,
        contact_preference: body.profile.contactPreference,
      },
      skills: {
        years_experience: body.skills.yearsExperience,
        skills: body.skills.skills,
        certifications: body.skills.certifications,
        languages: body.skills.languages,
      },
      motivation: {
        why_work_here: body.motivation.whyWorkHere,
        superpower: body.motivation.superpower,
        above_and_beyond: body.motivation.aboveAndBeyond,
        skill_answers: body.motivation.skillAnswers,
      },
    };

    try {
      const upload = await verifiedUpload(services, invitation.id, body.uploadId);
      if (!upload) return failure('INVALID_RESUME', 'Upload a valid PDF, JPG, or PNG résumé before submitting.', 400);
      // Store the applicant-reviewed answers and the verified source attachment.
      // OCR is limited to preview; concurrent final submissions cannot start
      // unbounded paid extractions before the one-use link is consumed.
      const resumeText = generateMarkdownFromSubmission(submission);
      const saved = await services.finalizeApplication(
        invitation.id, upload.grant.id, submission, resumeText, upload.sha256, passed,
      );
      if (!saved) return failure('ALREADY_SUBMITTED', 'This application link has already been used. Contact the employer if you need to reapply.', 409);
      return json({
        success: true,
        passed,
        applicationId: saved.applicationId,
        failedKnockouts: failedKnockouts.map(question => question.id),
        message: 'Application received.',
      }, 201);
    } catch (error) {
      console.error('[Production Application] Submission failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return failure('PERSISTENCE_UNAVAILABLE', 'The application could not be saved. Your answers are still here; please try again.', 503, true);
    }
  };
}
