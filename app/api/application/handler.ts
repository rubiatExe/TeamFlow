import { NextRequest, NextResponse } from 'next/server.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
    applicationExistsInSupabase,
    saveApplicationToSupabase,
    saveCandidateToSupabase,
    type ApplicationSubmission,
    type CandidateRow,
    DEMO_MERCHANT_ID,
} from '../../../lib/db/supabase.ts';
import {
    readBoundedJson,
    RequestBodyTooLargeError,
} from '../../../lib/http/bounded-json.ts';
import { guardLegacyDemoRoute } from '../../../lib/http/legacy-demo-route.ts';
import { deleteResume, uploadResume } from '../../../lib/db/storage.ts';
import {
    DocumentProcessorError,
    requestDocumentExtraction,
} from '../../../lib/ai/document-processor-client.ts';
import { ParserInputSchema } from '../../../lib/contracts/parser.ts';
import { matchesResumeSignature, resumeExtension } from '../../../lib/domain/resume-file.ts';
import {
    getRoleById,
    isRoleQuestionAnswerTypeValid,
    isRoleQuestionFailure,
} from '../../../lib/domain/roles.ts';

// A 10 MiB file becomes at most 13,981,016 base64 characters. Leave room for
// the other bounded application fields without accepting an unbounded upload.
const MAX_APPLICATION_REQUEST_BYTES = 14_200_000;
const MAX_APPLICATION_BODY_FRAMES = 2048;
const RESUME_EXTRACTION_TIMEOUT_MS = 25_000;
const ResumeSchema = ParserInputSchema.pick({
    fileData: true,
    mimeType: true,
    fileName: true,
}).strict();

const StringListSchema = z.array(z.string().trim().min(1).max(120)).max(50);
export const ApplicationRequestSchema = z.object({
    candidateId: z.string().trim().min(1).max(200).optional(),
    roleId: z.string().trim().min(1).max(100),
    basicInfo: z.object({
        fullName: z.string().trim().min(2).max(200),
        email: z.email().max(320),
        phone: z.string().trim().max(40).default(''),
        city: z.string().trim().max(200).default(''),
    }).strict(),
    knockoutAnswers: z.record(
        z.string().trim().min(1).max(100),
        z.union([z.string().max(500), z.boolean()]),
    ).default({}),
    profile: z.object({
        preferredShifts: StringListSchema.default([]),
        daysAvailable: StringListSchema.default([]),
        startDate: z.string().trim().max(40).default(''),
        transportation: z.string().trim().max(100).default(''),
        contactPreference: z.string().trim().max(100).default(''),
    }).strict(),
    skills: z.object({
        yearsExperience: z.string().trim().max(100).default(''),
        skills: StringListSchema.default([]),
        certifications: StringListSchema.default([]),
        languages: StringListSchema.default([]),
    }).strict(),
    motivation: z.object({
        whyWorkHere: z.string().max(2_000).default(''),
        superpower: z.string().max(500).default(''),
        aboveAndBeyond: z.string().max(2_000).default(''),
        skillAnswers: z.record(z.string().max(100), z.string().max(2_000)).default({}),
    }).strict(),
    resume: ResumeSchema,
}).strict();

export type ApplicationFailureCode =
    | 'INVALID_REQUEST'
    | 'REQUEST_TOO_LARGE'
    | 'PERSISTENCE_UNAVAILABLE'
    | 'INTERNAL_ERROR';

type ApplicationRouteDependencies = {
    saveApplication: typeof saveApplicationToSupabase;
    saveCandidate: typeof saveCandidateToSupabase;
    uploadResume: typeof uploadResume;
    deleteResume: typeof deleteResume;
    applicationExists: typeof applicationExistsInSupabase;
    extractResume: typeof requestDocumentExtraction;
};

const defaultDependencies: ApplicationRouteDependencies = {
    saveApplication: saveApplicationToSupabase,
    saveCandidate: saveCandidateToSupabase,
    uploadResume,
    deleteResume,
    applicationExists: applicationExistsInSupabase,
    extractResume: requestDocumentExtraction,
};

async function deleteUnreferencedResume(
    services: ApplicationRouteDependencies,
    applicationId: string,
    storagePath: string,
): Promise<void> {
    try {
        // A failed insert response can still be ambiguous. Remove applicant data
        // only when a fresh database read confirms no application references it.
        const applicationExists = await services.applicationExists(applicationId);
        if (applicationExists !== false) return;
        if (!await services.deleteResume(storagePath)) {
            console.warn('[Application API] Unreferenced résumé cleanup failed');
        }
    } catch (error) {
        console.warn('[Application API] Unreferenced résumé cleanup failed', {
            errorType: error instanceof Error ? error.name : 'UnknownError',
        });
    }
}

function json(body: unknown, status: number): NextResponse {
    return NextResponse.json(body, {
        status,
        headers: {
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}

function failure(
    code: ApplicationFailureCode,
    message: string,
    status: number,
    retryable: boolean,
): NextResponse {
    return json({ success: false, error: { code, message, retryable } }, status);
}

export function generateMarkdownFromSubmission(submission: ApplicationSubmission): string {
    const { basic_info, profile, skills, motivation } = submission;

    return `
# ${basic_info.full_name}

**Email:** ${basic_info.email}
**Phone:** ${basic_info.phone || 'Not provided'}
**Location:** ${basic_info.city || 'Not provided'}

## Availability
- **Preferred Shifts:** ${profile.preferred_shifts.join(', ') || 'Not specified'}
- **Days Available:** ${profile.days_available.join(', ') || 'Not specified'}
- **Available to Start:** ${profile.start_date || 'Not specified'}

## Experience & Skills
- **Years of Experience:** ${skills.years_experience}
- **Relevant Skills:** ${skills.skills.join(', ') || 'None listed'}
- **Languages:** ${skills.languages.join(', ') || 'Not specified'}
- **Certifications:** ${skills.certifications.join(', ') || 'None'}

## Motivation & Personality
**Why do you want to work here?**
${motivation.why_work_here || 'No answer provided.'}

**What is your superpower?**
${motivation.superpower || 'No answer provided.'}

**Tell us about a time you went above and beyond:**
${motivation.above_and_beyond || 'No answer provided.'}
    `.trim();
}

export function createApplicationPost(
    dependencies: Partial<ApplicationRouteDependencies> = {},
) {
    const services = { ...defaultDependencies, ...dependencies };
    return async function applicationPost(req: NextRequest): Promise<NextResponse> {
        const blocked = guardLegacyDemoRoute();
        if (blocked) return blocked as NextResponse;

        let rawBody: unknown;
        try {
            rawBody = await readBoundedJson(req, MAX_APPLICATION_REQUEST_BYTES, {
                maxFrames: MAX_APPLICATION_BODY_FRAMES,
            });
        } catch (error) {
            if (error instanceof RequestBodyTooLargeError) {
                return failure('REQUEST_TOO_LARGE', 'The application is too large to submit.', 413, false);
            }
            return failure('INVALID_REQUEST', 'The application request is not valid JSON.', 400, false);
        }

        const parsedBody = ApplicationRequestSchema.safeParse(rawBody);
        if (!parsedBody.success) {
            return failure('INVALID_REQUEST', 'Please review the required application fields.', 400, false);
        }

        const body = parsedBody.data;
        const resumeBytes = Buffer.from(body.resume.fileData, 'base64');
        const extension = resumeExtension(body.resume.mimeType, body.resume.fileName);
        if (!extension || !matchesResumeSignature(resumeBytes, body.resume.mimeType)) {
            return failure('INVALID_REQUEST', 'Please attach a valid PDF, JPG, or PNG résumé.', 400, false);
        }
        const role = getRoleById(body.roleId);
        if (!role) {
            return failure('INVALID_REQUEST', 'Please choose a supported role.', 400, false);
        }
        const expectedQuestionIds = new Set(role.questions.knockout.map(question => question.id));
        const suppliedQuestionIds = Object.keys(body.knockoutAnswers);
        if (
            suppliedQuestionIds.length !== expectedQuestionIds.size
            || suppliedQuestionIds.some(questionId => !expectedQuestionIds.has(questionId))
            || role.questions.knockout.some(question => {
                const answer = body.knockoutAnswers[question.id];
                return answer === undefined || !isRoleQuestionAnswerTypeValid(question, answer);
            })
        ) {
            return failure(
                'INVALID_REQUEST',
                'Please answer every required role question using the expected response type.',
                400,
                false,
            );
        }
        const failedKnockouts = role.questions.knockout.filter(question =>
            isRoleQuestionFailure(question, body.knockoutAnswers[question.id]),
        );
        const passed = failedKnockouts.length === 0;

        const submission: ApplicationSubmission = {
            // The legacy invite payload is only decoded in the browser, so it
            // cannot establish an authorized candidate relationship here.
            role_id: body.roleId,
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

        const applicationId = randomUUID();
        const storagePath = `webform_${applicationId}/${randomUUID()}.${extension}`;
        const resumeFile = new Blob([Uint8Array.from(resumeBytes)], { type: body.resume.mimeType });
        const resumeContentSha256 = createHash('sha256').update(resumeBytes).digest('hex');
        let applicationWasSaved = false;
        let uploadedPath: string | null = null;
        try {
            uploadedPath = await services.uploadResume(resumeFile, storagePath);
            if (uploadedPath !== storagePath) {
                return failure(
                    'PERSISTENCE_UNAVAILABLE',
                    'Your résumé could not be saved. Your answers are still here; please try again.',
                    503,
                    true,
                );
            }
            submission.resume = {
                file_name: body.resume.fileName,
                mime_type: body.resume.mimeType,
                storage_path: uploadedPath,
                content_sha256: resumeContentSha256,
            };

            const reviewedAnswers = generateMarkdownFromSubmission(submission);
            let resumeText = reviewedAnswers;
            try {
                const extraction = await services.extractResume({
                    bytes: resumeBytes,
                    mimeType: body.resume.mimeType,
                    fileName: body.resume.fileName,
                    serviceUrl: process.env.OCR_SERVICE_URL || 'http://localhost:8000',
                    token: process.env.OCR_SERVICE_TOKEN || '',
                    timeoutMs: RESUME_EXTRACTION_TIMEOUT_MS,
                });
                const sourceHeading = '## Source résumé extraction';
                const reviewedHeading = '## Applicant-reviewed form answers';
                const surroundingText = `${sourceHeading}\n\n\n\n${reviewedHeading}\n\n${reviewedAnswers}`;
                const sourceLimit = Math.max(0, 50_000 - surroundingText.length);
                resumeText = `${sourceHeading}\n\n${extraction.markdown.slice(0, sourceLimit)}\n\n${reviewedHeading}\n\n${reviewedAnswers}`;
            } catch (error) {
                console.warn('[Application API] Resume extraction unavailable', {
                    code: error instanceof DocumentProcessorError ? error.code : 'unknown',
                });
            }

            const savedApplicationId = await services.saveApplication(submission, applicationId);
            if (savedApplicationId !== applicationId) {
                await deleteUnreferencedResume(services, applicationId, uploadedPath);
                return failure(
                    'PERSISTENCE_UNAVAILABLE',
                    'Your application was not saved. Your answers are still here; please try again.',
                    503,
                    true,
                );
            }
            applicationWasSaved = true;

            const candidateRow: CandidateRow = {
                merchant_id: DEMO_MERCHANT_ID,
                name: body.basicInfo.fullName,
                email: body.basicInfo.email,
                phone: body.basicInfo.phone,
                city: body.basicInfo.city || 'Local Area',
                status: 'new',
                resume_url: uploadedPath,
                resume_text: resumeText,
                summary: passed
                    ? 'Awaiting authorized human review'
                    : 'Required responses flagged for authorized human review',
                source: 'Web Form',
            };
            const candidateRecordId = await services.saveCandidate(candidateRow);
            if (!candidateRecordId) {
                return failure(
                    'PERSISTENCE_UNAVAILABLE',
                    'The application could not be finalized. Please contact the employer before retrying.',
                    503,
                    false,
                );
            }

            return json({
                success: true,
                passed,
                applicationId,
                failedKnockouts: failedKnockouts.map(question => question.id),
                message: 'Application received.',
            }, 201);
        } catch (error) {
            if (!applicationWasSaved && uploadedPath) {
                await deleteUnreferencedResume(services, applicationId, uploadedPath);
            }
            console.error('[Application API] Submission failed', {
                errorType: error instanceof Error ? error.name : 'UnknownError',
            });
            return failure(
                'INTERNAL_ERROR',
                applicationWasSaved
                    ? 'The application could not be finalized. Please contact the employer before retrying.'
                    : 'The application could not be processed. Please try again.',
                500,
                !applicationWasSaved,
            );
        }
    };
}
