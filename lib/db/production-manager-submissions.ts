import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PAGE_SIZE = 25;
const MAX_PAGE = 100;
const MIME_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

const SavedAnswersSchema = z.object({
  basic_info: z.object({
    full_name: z.string(), email: z.string(), phone: z.string(), city: z.string().optional(),
  }),
  knockout_answers: z.record(z.string(), z.union([z.string(), z.boolean()])),
  profile: z.object({
    preferred_shifts: z.array(z.string()),
    days_available: z.array(z.string()),
    start_date: z.string(),
    transportation: z.string(),
    contact_preference: z.string(),
  }),
  skills: z.object({
    years_experience: z.string(),
    skills: z.array(z.string()),
    certifications: z.array(z.string()),
    languages: z.array(z.string()),
  }),
  motivation: z.object({
    why_work_here: z.string(),
    superpower: z.string(),
    above_and_beyond: z.string(),
    skill_answers: z.record(z.string(), z.string()),
  }),
  resume: z.object({
    file_name: z.string(),
    mime_type: z.string(),
    storage_path: z.string(),
  }),
});

type SavedAnswers = z.infer<typeof SavedAnswersSchema>;

export type ManagerSubmission = {
  id: string;
  candidateId: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  roleId: string;
  submittedAt: string;
  resumeFileName: string;
  answers: Omit<SavedAnswers, 'basic_info' | 'resume'>;
};

export type ManagerSubmissionPage = {
  submissions: ManagerSubmission[];
  nextPage: number | null;
};

type InvitationRow = {
  id: string;
  merchant_id: string;
  role_id: string;
  submitted_at: string;
  submitted_application_id: string;
  submitted_upload_id: string;
};

type ApplicationRow = {
  id: string;
  candidate_id: string | null;
  role_id: string;
  data: unknown;
};

type CandidateRow = {
  id: string;
  merchant_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  resume_url: string;
};

type UploadRow = {
  id: string;
  invitation_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  revoked_at: string | null;
};

let productionClient: SupabaseClient | null = null;

function dbClient(): SupabaseClient {
  if (typeof window !== 'undefined') throw new Error('Manager submissions are server-only.');
  if (productionClient) return productionClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Manager submissions are not configured.');
  productionClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return productionClient;
}

async function hasManagerAccess(db: SupabaseClient, actorUserId: string, merchantId: string): Promise<boolean> {
  const { data, error } = await db.from('merchant_memberships')
    .select('merchant_id')
    .eq('user_id', actorUserId)
    .eq('merchant_id', merchantId)
    .eq('status', 'active')
    .in('role', ['owner', 'manager'])
    .maybeSingle();
  if (error) throw new Error('Manager authorization could not be checked.');
  return Boolean(data);
}

function isRegisteredResumePath(invitationId: string, upload: UploadRow): boolean {
  const extension = MIME_EXTENSION[upload.mime_type];
  if (!extension) return false;
  const prefix = `candidate-invitations/${invitationId}/`;
  if (!upload.storage_path.startsWith(prefix)) return false;
  const basename = upload.storage_path.slice(prefix.length);
  return basename.endsWith(`.${extension}`)
    && UUID_RE.test(basename.slice(0, -(extension.length + 1)));
}

/** Preserve only the information a manager needs; private paths never enter list responses. */
export function mapManagerSubmission(
  merchantId: string,
  invitation: InvitationRow,
  application: ApplicationRow | undefined,
  candidate: CandidateRow | undefined,
  upload: UploadRow | undefined,
): ManagerSubmission | null {
  if (!application || !candidate || !upload
    || invitation.merchant_id !== merchantId
    || application.id !== invitation.submitted_application_id
    || application.candidate_id !== candidate.id
    || application.role_id !== invitation.role_id
    || candidate.merchant_id !== merchantId
    || candidate.resume_url !== upload.storage_path
    || upload.id !== invitation.submitted_upload_id
    || upload.invitation_id !== invitation.id
    || !isRegisteredResumePath(invitation.id, upload)
    || upload.revoked_at !== null) return null;
  const parsed = SavedAnswersSchema.safeParse(application.data);
  if (!parsed.success || parsed.data.resume.storage_path !== upload.storage_path
    || parsed.data.resume.file_name !== upload.file_name
    || parsed.data.resume.mime_type !== upload.mime_type) return null;
  const { basic_info } = parsed.data;
  const answers = {
    knockout_answers: parsed.data.knockout_answers,
    profile: parsed.data.profile,
    skills: parsed.data.skills,
    motivation: parsed.data.motivation,
  };
  return {
    id: application.id,
    candidateId: candidate.id,
    name: candidate.name,
    email: candidate.email ?? basic_info.email,
    phone: candidate.phone ?? basic_info.phone,
    city: basic_info.city ?? candidate.city ?? '',
    roleId: invitation.role_id,
    submittedAt: invitation.submitted_at,
    resumeFileName: upload.file_name,
    answers,
  };
}

export async function listManagerSubmissions(
  actorUserId: string,
  merchantId: string,
  page: number,
): Promise<ManagerSubmissionPage | null> {
  if (!UUID_RE.test(actorUserId) || !UUID_RE.test(merchantId)
    || !Number.isInteger(page) || page < 0 || page > MAX_PAGE) return null;
  const db = dbClient();
  if (!await hasManagerAccess(db, actorUserId, merchantId)) return null;

  const start = page * PAGE_SIZE;
  const { data: invitations, error: invitationError } = await db
    .from('candidate_application_invitations')
    .select('id,merchant_id,role_id,submitted_at,submitted_application_id,submitted_upload_id')
    .eq('merchant_id', merchantId)
    .not('submitted_at', 'is', null)
    .order('submitted_at', { ascending: false })
    .range(start, start + PAGE_SIZE);
  if (invitationError || !invitations) throw new Error('Manager applications could not be loaded.');
  const rows = invitations as InvitationRow[];
  const pageRows = rows.slice(0, PAGE_SIZE);
  if (pageRows.length === 0) return { submissions: [], nextPage: null };

  const applicationIds = pageRows.map(row => row.submitted_application_id);
  const uploadIds = pageRows.map(row => row.submitted_upload_id);
  const { data: applications, error: applicationError } = await db.from('applications')
    .select('id,candidate_id,role_id,data').in('id', applicationIds);
  const { data: uploads, error: uploadError } = await db.from('candidate_resume_uploads')
    .select('id,invitation_id,storage_path,file_name,mime_type,revoked_at').in('id', uploadIds);
  if (applicationError || uploadError || !applications || !uploads) {
    throw new Error('Manager applications could not be loaded.');
  }
  const applicationRows = applications as ApplicationRow[];
  const candidateIds = applicationRows.flatMap(row => row.candidate_id ? [row.candidate_id] : []);
  const { data: candidates, error: candidateError } = candidateIds.length === 0
    ? { data: [] as CandidateRow[], error: null }
    : await db.from('candidates')
      .select('id,merchant_id,name,email,phone,city,resume_url')
      .eq('merchant_id', merchantId)
      .in('id', candidateIds);
  if (candidateError || !candidates) throw new Error('Manager applications could not be loaded.');

  const applicationById = new Map(applicationRows.map(row => [row.id, row]));
  const candidateById = new Map((candidates as CandidateRow[]).map(row => [row.id, row]));
  const uploadById = new Map((uploads as UploadRow[]).map(row => [row.id, row]));
  const submissions = pageRows.flatMap(row => {
    const application = applicationById.get(row.submitted_application_id);
    const mapped = mapManagerSubmission(
      merchantId, row, application,
      application?.candidate_id ? candidateById.get(application.candidate_id) : undefined,
      uploadById.get(row.submitted_upload_id),
    );
    return mapped ? [mapped] : [];
  });
  return { submissions, nextPage: rows.length > PAGE_SIZE ? page + 1 : null };
}

export async function createManagerResumeUrl(
  actorUserId: string,
  merchantId: string,
  applicationId: string,
): Promise<string | null> {
  if (!UUID_RE.test(actorUserId) || !UUID_RE.test(merchantId) || !UUID_RE.test(applicationId)) return null;
  const db = dbClient();
  if (!await hasManagerAccess(db, actorUserId, merchantId)) return null;
  const { data: invitation, error: invitationError } = await db
    .from('candidate_application_invitations')
    .select('id,merchant_id,role_id,submitted_at,submitted_application_id,submitted_upload_id')
    .eq('merchant_id', merchantId)
    .eq('submitted_application_id', applicationId)
    .not('submitted_at', 'is', null)
    .maybeSingle();
  if (invitationError) throw new Error('Manager résumé could not be located.');
  if (!invitation) return null;
  const row = invitation as InvitationRow;
  const [applicationResult, uploadResult] = await Promise.all([
    db.from('applications').select('id,candidate_id,role_id,data').eq('id', applicationId).maybeSingle(),
    db.from('candidate_resume_uploads')
      .select('id,invitation_id,storage_path,file_name,mime_type,revoked_at')
      .eq('id', row.submitted_upload_id).maybeSingle(),
  ]);
  if (applicationResult.error || uploadResult.error) throw new Error('Manager résumé could not be located.');
  const application = applicationResult.data as ApplicationRow | null;
  const upload = uploadResult.data as UploadRow | null;
  if (!application?.candidate_id || !upload) return null;
  const { data: candidate, error: candidateError } = await db.from('candidates')
    .select('id,merchant_id,name,email,phone,city,resume_url')
    .eq('id', application.candidate_id)
    .eq('merchant_id', merchantId)
    .maybeSingle();
  if (candidateError) throw new Error('Manager résumé could not be located.');
  if (!mapManagerSubmission(merchantId, row, application, (candidate as CandidateRow | null) ?? undefined, upload)) return null;
  const bucket = db.storage.from('resumes');
  const info = await bucket.info(upload.storage_path);
  if (info.error?.status === 404) return null;
  if (info.error || !info.data) throw new Error('Manager résumé could not be opened.');
  const { data, error } = await bucket.createSignedUrl(upload.storage_path, 60);
  if (error || !data?.signedUrl) throw new Error('Manager résumé link could not be created.');
  return data.signedUrl;
}
