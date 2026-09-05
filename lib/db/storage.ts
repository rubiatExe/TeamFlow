
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let storageClient: SupabaseClient | null = null;
const BUCKET_NAME = 'resumes';
const MAX_RESUME_BYTES = 10 * 1024 * 1024;

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
    if (!isSafeObjectPath(path) || file.size <= 0 || file.size > MAX_RESUME_BYTES) {
      return null;
    }
    const supabase = getStorageClient();
    if (!supabase) return null;

    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(path, file, {
        cacheControl: '3600',
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

/**
 * Generates a signed URL for a private file (if we switch to private buckets later).
 */
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
