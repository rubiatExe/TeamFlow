
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let storageClient: SupabaseClient | null = null;
const BUCKET_NAME = 'resumes';
const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const RESUME_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

function getStorageClient(): SupabaseClient | null {
  if (typeof window !== 'undefined') {
    console.warn('[Supabase Storage] Resume storage is server-only');
    return null;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.warn('[Supabase Storage] Missing server-side Supabase configuration');
    return null;
  }

  storageClient ??= createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return storageClient;
}

function isSafeObjectPath(path: string): boolean {
  if (!path || path !== path.trim() || path.length > 1024) return false;
  if (/[\u0000-\u001f\u007f\\]/u.test(path)) return false;
  const segments = path.split('/');
  return segments.every(segment => segment && segment !== '.' && segment !== '..');
}

/**
 * Uploads a file to Supabase Storage.
 * @param file The file object (File or Blob)
 * @param path The path to store the file (e.g., "candidate_id/resume.pdf")
 * @returns The private Storage object path. Call `getSignedUrl` for temporary access.
 */
export async function uploadResume(file: File | Blob, path: string): Promise<string | null> {
  try {
    if (!isSafeObjectPath(path) || file.size <= 0 || file.size > MAX_RESUME_BYTES
      || !RESUME_MIME_TYPES.has(file.type)) {
      return null;
    }
    const supabase = getStorageClient();
    if (!supabase) return null;

    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(path, file, {
        cacheControl: '3600',
        contentType: file.type,
        upsert: false,
      });

    if (error) {
      console.error('Error uploading resume:', error);
      return null;
    }

    return data.path;
  } catch (err) {
    console.error('Unexpected error uploading resume:', err);
    return null;
  }
}

/** Mint a short-lived capability for one server-chosen path in the private bucket. */
export async function createSignedResumeUpload(path: string): Promise<string | null> {
  if (!isSafeObjectPath(path)) return null;
  const supabase = getStorageClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUploadUrl(path, { upsert: false });
    if (error) {
      console.warn('[Supabase Storage] Signed resume upload failed', { code: error.name });
      return null;
    }
    return data.token;
  } catch (error) {
    console.warn('[Supabase Storage] Signed resume upload failed unexpectedly', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return null;
  }
}

/** Read only a server-registered path; callers must validate its bytes and metadata. */
export async function downloadResume(path: string): Promise<Blob | null> {
  if (!isSafeObjectPath(path)) return null;
  const supabase = getStorageClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.storage.from(BUCKET_NAME).download(path);
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

/** Remove an upload only after the caller confirms no application row references it. */
export async function deleteResume(path: string): Promise<boolean> {
  if (!isSafeObjectPath(path)) return false;
  const supabase = getStorageClient();
  if (!supabase) return false;

  try {
    const { error } = await supabase.storage.from(BUCKET_NAME).remove([path]);
    if (error) {
      console.warn('[Supabase Storage] Resume cleanup failed', {
        code: error.name,
      });
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[Supabase Storage] Resume cleanup failed unexpectedly', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return false;
  }
}

/** Generate a five-minute read URL for a private résumé after caller authorization. */
export async function getSignedUrl(path: string): Promise<string | null> {
    if (!isSafeObjectPath(path)) return null;
    const supabase = getStorageClient();
    if (!supabase) return null;

    const { data, error } = await supabase.storage
        .from(BUCKET_NAME)
        .createSignedUrl(path, 5 * 60);

    if (error) {
        console.error("Error creating signed URL:", error);
        return null;
    }
    return data.signedUrl;
}
