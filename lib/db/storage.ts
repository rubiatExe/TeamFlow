
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let storageClient: SupabaseClient | null = null;

function getStorageClient(): SupabaseClient | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[Supabase Storage] Missing public Supabase configuration');
    return null;
  }

  storageClient ??= createClient(supabaseUrl, supabaseKey);
  return storageClient;
}

const BUCKET_NAME = 'resumes';

/**
 * Uploads a file to Supabase Storage.
 * @param file The file object (File or Blob)
 * @param path The path to store the file (e.g., "candidate_id/resume.pdf")
 * @returns The public URL of the uploaded file
 */
export async function uploadResume(file: File | Blob, path: string): Promise<string | null> {
  try {
    const supabase = getStorageClient();
    if (!supabase) return null;

    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(path, file, {
        cacheControl: '3600',
        upsert: false,
      });

    if (error) {
      console.error('Error uploading resume:', error);
      return null;
    }

    // Get public URL
    const { data: publicUrlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(path);

    return publicUrlData.publicUrl;
  } catch (err) {
    console.error('Unexpected error uploading resume:', err);
    return null;
  }
}

/**
 * Generates a signed URL for a private file (if we switch to private buckets later).
 */
export async function getSignedUrl(path: string): Promise<string | null> {
    const supabase = getStorageClient();
    if (!supabase) return null;

    const { data, error } = await supabase.storage
        .from(BUCKET_NAME)
        .createSignedUrl(path, 60 * 60); // 1 hour

    if (error) {
        console.error("Error creating signed URL:", error);
        return null;
    }
    return data.signedUrl;
}
