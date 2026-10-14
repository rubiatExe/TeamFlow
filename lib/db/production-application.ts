import { createHash, randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { ApplicationSubmission } from './supabase.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const MAX_UPLOADS_PER_INVITATION = 3;
const MIME_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

let productionClient: SupabaseClient | null = null;

/** This client never falls back to the browser publishable key. */
function getProductionClient(): SupabaseClient | null {
  if (typeof window !== 'undefined') return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    productionClient ??= createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  } catch {
    return null;
  }
  return productionClient;
}

export interface ProductionInvitation {
  id: string;
  merchantId: string;
  merchantName: string;
  roleId: string;
  jobId: string | null;
  candidateName: string | null;
  expiresAt: string;
  uploadCount: number;
}

export interface ProductionUploadGrant {
  id: string;
  invitationId: string;
  storagePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  previewCount: number;
}

export type RegisterUploadGrantResult =
  | { status: 'created'; grant: ProductionUploadGrant }
  | { status: 'limit' }
  | { status: 'unavailable' };

export interface SubmittedApplicationReceipt {
  applicationId: string;
  passed: boolean;
}

export interface AbandonedUploadGrant {
  id: string;
  storagePath: string;
}

export interface CreateProductionInvitationInput {
  merchantId: string;
  roleId: string;
  jobId?: string | null;
  candidateName?: string | null;
  ttlMinutes?: number;
}

export interface RegisterUploadGrantInput {
  storagePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

interface InvitationRow {
  id: string;
  merchant_id: string;
  role_id: string;
  job_id: string | null;
  candidate_name: string | null;
  expires_at: string;
  upload_count: number;
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function mapInvitation(row: InvitationRow, merchantName: string): ProductionInvitation {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    merchantName,
    roleId: row.role_id,
    jobId: row.job_id,
    candidateName: row.candidate_name,
    expiresAt: row.expires_at,
    uploadCount: row.upload_count,
  };
}

function validFileName(fileName: string): boolean {
  return fileName.length > 0 && Array.from(fileName).length <= 255
    && !/[\\/\u0000-\u001f\u007f]/u.test(fileName);
}

function validUploadPath(invitationId: string, path: string, mimeType: string): boolean {
  const extension = MIME_EXTENSION[mimeType];
  if (!extension) return false;
  const prefix = `candidate-invitations/${invitationId}/`;
  if (!path.startsWith(prefix)) return false;
  const basename = path.slice(prefix.length);
  const dot = basename.lastIndexOf('.');
  return dot > 0 && isUuid(basename.slice(0, dot))
    && basename.slice(dot + 1) === extension;
}

/**
 * The caller must verify the bearer credential with Supabase Auth first. This
 * second check binds the authenticated actor to the selected merchant.
 */
export async function createProductionInvitation(
  actorUserId: string,
  input: CreateProductionInvitationInput,
): Promise<{ token: string; invitation: ProductionInvitation } | null> {
  const db = getProductionClient();
  const roleId = input.roleId.trim();
  const candidateName = input.candidateName?.trim() || null;
  const ttlMinutes = input.ttlMinutes ?? 72 * 60;
  if (!db || !isUuid(actorUserId) || !isUuid(input.merchantId)
    || roleId.length < 1 || roleId.length > 120
    || (input.jobId != null && !isUuid(input.jobId))
    || (candidateName !== null && candidateName.length > 200)
    || !Number.isInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 7 * 24 * 60) {
    return null;
  }

  try {
    const { data: membership, error: membershipError } = await db
      .from('merchant_memberships')
      .select('merchant_id')
      .eq('user_id', actorUserId)
      .eq('merchant_id', input.merchantId)
      .eq('status', 'active')
      .in('role', ['owner', 'manager'])
      .maybeSingle();
    if (membershipError || !membership) return null;

    const { data: merchant, error: merchantError } = await db
      .from('merchants')
      .select('id,store_name')
      .eq('id', input.merchantId)
      .maybeSingle();
    if (merchantError || !merchant || typeof merchant.store_name !== 'string') return null;

    if (input.jobId) {
      const { data: job, error: jobError } = await db
        .from('jobs')
        .select('id')
        .eq('id', input.jobId)
        .eq('merchant_id', input.merchantId)
        .eq('is_active', true)
        .maybeSingle();
      if (jobError || !job) return null;
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    const { data, error } = await db
      .from('candidate_application_invitations')
      .insert({
        token_hash: tokenHash(token),
        merchant_id: input.merchantId,
        role_id: roleId,
        job_id: input.jobId ?? null,
        candidate_name: candidateName,
        created_by: actorUserId,
        expires_at: expiresAt,
      })
      .select('id,merchant_id,role_id,job_id,candidate_name,expires_at,upload_count')
      .single();
    if (error || !data) return null;
    return {
      token,
      invitation: mapInvitation(data as InvitationRow, merchant.store_name),
    };
  } catch {
    return null;
  }
}

/** Returns no result for malformed, expired, or already submitted links. */
export async function verifyInvitation(token: string): Promise<ProductionInvitation | null> {
  if (!TOKEN_RE.test(token)) return null;
  const db = getProductionClient();
  if (!db) throw new Error('Candidate invitation service is unavailable.');
  const { data, error } = await db
    .from('candidate_application_invitations')
    .select('id,merchant_id,role_id,job_id,candidate_name,expires_at,upload_count')
    .eq('token_hash', tokenHash(token))
    .is('submitted_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error) throw new Error('Candidate invitation query failed.');
  if (!data) return null;
  const row = data as InvitationRow;
  const { data: merchant, error: merchantError } = await db
    .from('merchants')
    .select('store_name')
    .eq('id', row.merchant_id)
    .maybeSingle();
  if (merchantError) throw new Error('Candidate invitation merchant query failed.');
  if (!merchant || typeof merchant.store_name !== 'string') return null;
  return mapInvitation(row, merchant.store_name);
}

/** Atomically reserves one of at most three signed uploads for this invitation. */
export async function registerUploadGrant(
  invitationId: string,
  input: RegisterUploadGrantInput,
): Promise<RegisterUploadGrantResult> {
  const db = getProductionClient();
  if (!db || !isUuid(invitationId)
    || !validUploadPath(invitationId, input.storagePath, input.mimeType)
    || !validFileName(input.fileName)
    || !Number.isInteger(input.sizeBytes)
    || input.sizeBytes < 1 || input.sizeBytes > MAX_RESUME_BYTES) return { status: 'unavailable' };
  try {
    const { data, error } = await db.rpc('teamflow_register_candidate_resume_upload', {
      p_invitation_id: invitationId,
      p_storage_path: input.storagePath,
      p_file_name: input.fileName,
      p_mime_type: input.mimeType,
      p_size_bytes: input.sizeBytes,
    });
    if (error?.code === 'PT429') return { status: 'limit' };
    if (error || typeof data !== 'string' || !isUuid(data)) return { status: 'unavailable' };
    return {
      status: 'created',
      grant: {
        id: data,
        invitationId,
        storagePath: input.storagePath,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        previewCount: 0,
      },
    };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Undo an unconsumed grant when Storage could not mint its signed token. */
export async function releaseUploadGrant(invitationId: string, uploadId: string): Promise<boolean> {
  const db = getProductionClient();
  if (!db || !isUuid(invitationId) || !isUuid(uploadId)) return false;
  const { data, error } = await db.rpc('teamflow_release_candidate_resume_upload', {
    p_invitation_id: invitationId,
    p_upload_id: uploadId,
  });
  return !error && data === true;
}

/** A receipt is only returned for the exact submitted invitation and upload. */
export async function findSubmittedReceipt(
  token: string,
  uploadId: string,
): Promise<SubmittedApplicationReceipt | null> {
  if (!TOKEN_RE.test(token) || !isUuid(uploadId)) return null;
  const db = getProductionClient();
  if (!db) throw new Error('Candidate application receipt service is unavailable.');
  const { data, error } = await db
    .from('candidate_application_invitations')
    .select('submitted_application_id,submitted_passed')
    .eq('token_hash', tokenHash(token))
    .eq('submitted_upload_id', uploadId)
    .not('submitted_at', 'is', null)
    .maybeSingle();
  if (error) throw new Error('Candidate application receipt query failed.');
  if (!data) return null;
  if (typeof data.submitted_application_id !== 'string'
    || !isUuid(data.submitted_application_id)
    || typeof data.submitted_passed !== 'boolean') {
    throw new Error('Candidate application receipt is invalid.');
  }
  return { applicationId: data.submitted_application_id, passed: data.submitted_passed };
}

export async function findUploadGrant(
  invitationId: string,
  uploadId: string,
): Promise<ProductionUploadGrant | null> {
  const db = getProductionClient();
  if (!db || !isUuid(invitationId) || !isUuid(uploadId)) return null;
  const { data, error } = await db
    .from('candidate_resume_uploads')
    .select('id,invitation_id,storage_path,file_name,mime_type,size_bytes,preview_count,revoked_at')
    .eq('id', uploadId)
    .eq('invitation_id', invitationId)
    .maybeSingle();
  if (error || !data || data.revoked_at !== null) return null;
  return {
    id: data.id,
    invitationId: data.invitation_id,
    storagePath: data.storage_path,
    fileName: data.file_name,
    mimeType: data.mime_type,
    sizeBytes: data.size_bytes,
    previewCount: data.preview_count,
  };
}

/** Atomically reserves one of three OCR previews for this upload. */
export async function reservePreview(invitationId: string, uploadId: string): Promise<boolean> {
  const db = getProductionClient();
  if (!db || !isUuid(invitationId) || !isUuid(uploadId)) return false;
  const { data, error } = await db.rpc('teamflow_reserve_candidate_resume_preview', {
    p_invitation_id: invitationId,
    p_upload_id: uploadId,
  });
  return !error && data === true;
}

/**
 * The route must download the registered private object and verify its bytes
 * before calling this. Only the server-computed hash is accepted here.
 */
export async function finalizeProductionApplication(
  invitationId: string,
  uploadId: string,
  submission: ApplicationSubmission,
  resumeText: string,
  resumeContentSha256: string,
  passed: boolean,
): Promise<{ candidateId: string; applicationId: string } | null> {
  const db = getProductionClient();
  if (!db || !isUuid(invitationId) || !isUuid(uploadId)
    || !SHA256_RE.test(resumeContentSha256)
    || resumeText.length > 100_000 || typeof passed !== 'boolean') return null;
  const { data, error } = await db.rpc('teamflow_finalize_candidate_application', {
    p_invitation_id: invitationId,
    p_upload_id: uploadId,
    p_submission: submission,
    p_resume_text: resumeText,
    p_resume_sha256: resumeContentSha256,
    p_passed: passed,
  });
  if (error || !data || typeof data !== 'object') return null;
  const result = data as Record<string, unknown>;
  if (typeof result.candidateId !== 'string' || !isUuid(result.candidateId)
    || typeof result.applicationId !== 'string' || !isUuid(result.applicationId)) return null;
  return { candidateId: result.candidateId, applicationId: result.applicationId };
}

/** Lists old, unreferenced uploads without exposing any applicant data. */
export async function listAbandonedUploadGrants(
  beforeIso: string,
  limit = 50,
): Promise<AbandonedUploadGrant[]> {
  const db = getProductionClient();
  if (!db || !Number.isFinite(Date.parse(beforeIso))
    || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Candidate résumé cleanup is unavailable.');
  }
  const { data, error } = await db.rpc('teamflow_list_abandoned_resume_uploads', {
    p_before: beforeIso,
    p_limit: limit,
  });
  if (error || !Array.isArray(data)) throw new Error('Candidate résumé cleanup query failed.');
  return data.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error('Candidate résumé cleanup returned invalid data.');
    const value = row as Record<string, unknown>;
    if (typeof value.id !== 'string' || !isUuid(value.id)
      || typeof value.storage_path !== 'string') {
      throw new Error('Candidate résumé cleanup returned invalid data.');
    }
    return { id: value.id, storagePath: value.storage_path };
  });
}

/** Claim first, then delete Storage; a claimed upload cannot be submitted. */
export async function claimAbandonedUploadGrant(uploadId: string): Promise<string | null> {
  const db = getProductionClient();
  if (!db || !isUuid(uploadId)) throw new Error('Candidate résumé cleanup is unavailable.');
  const { data, error } = await db.rpc('teamflow_claim_abandoned_resume_upload', {
    p_upload_id: uploadId,
  });
  if (error) throw new Error('Candidate résumé cleanup claim failed.');
  if (data === null) return null;
  if (typeof data !== 'string') throw new Error('Candidate résumé cleanup claim returned invalid data.');
  return data;
}

/** Remove the grant only after the private Storage object was deleted. */
export async function deleteAbandonedUploadGrant(uploadId: string): Promise<boolean> {
  const db = getProductionClient();
  if (!db || !isUuid(uploadId)) throw new Error('Candidate résumé cleanup is unavailable.');
  const { data, error } = await db.rpc('teamflow_delete_abandoned_resume_upload', {
    p_upload_id: uploadId,
  });
  if (error || typeof data !== 'boolean') {
    throw new Error('Candidate résumé cleanup delete failed.');
  }
  return data;
}

export { MAX_UPLOADS_PER_INVITATION };
