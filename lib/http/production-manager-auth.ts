import { createClient } from '@supabase/supabase-js';

/** Manager bearer credentials are verified against Supabase Auth on every request. */
export function parseManagerBearer(headers: Headers): string | null {
  const match = headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._-]{20,8192})$/u);
  return match?.[1] ?? null;
}

export async function verifyProductionManagerJwt(jwt: string): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Manager authentication is not configured.');
  }
  const auth = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const result = await auth.auth.getUser(jwt);
  if (result.error || !result.data.user || result.data.user.is_anonymous) return null;
  return result.data.user.id;
}
