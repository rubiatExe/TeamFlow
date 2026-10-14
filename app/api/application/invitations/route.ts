import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { createProductionInvitation } from '@/lib/db/production-application';
import {
  createDeadlineSignal,
  readBoundedJson,
  validateBoundedJsonRequestHeaders,
  RequestBodyTooLargeError,
} from '@/lib/http/bounded-json';
import { getRoleById } from '@/lib/domain/roles';

const InvitationRequestSchema = z.object({
  merchantId: z.uuid(),
  roleId: z.string().min(1).max(100),
  jobId: z.uuid().optional(),
  candidateName: z.string().trim().min(1).max(200).optional(),
  ttlMinutes: z.number().int().min(10).max(10_080).optional(),
}).strict();

const HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: HEADERS });
}

function configuredApplicationOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:')) return null;
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url.origin;
  } catch { return null; }
}

function managerBearer(request: NextRequest): string | null {
  const raw = request.headers.get('authorization');
  const match = raw?.match(/^Bearer ([A-Za-z0-9._-]{20,8192})$/u);
  return match?.[1] ?? null;
}

export async function POST(request: NextRequest) {
  const jwt = managerBearer(request);
  if (!jwt) return json({ error: 'A manager sign-in is required.' }, 401);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const appOrigin = configuredApplicationOrigin();
  if (!url || !anonKey || !appOrigin || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Application invitations are not configured.' }, 503);
  }

  let actorUserId: string;
  try {
    const auth = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const result = await auth.auth.getUser(jwt);
    if (result.error || !result.data.user || result.data.user.is_anonymous) {
      return json({ error: 'A manager sign-in is required.' }, 401);
    }
    actorUserId = result.data.user.id;
  } catch {
    return json({ error: 'Manager sign-in could not be verified.' }, 503);
  }

  let raw: unknown;
  const deadline = createDeadlineSignal(5_000, request.signal);
  try {
    validateBoundedJsonRequestHeaders(request, 2_048);
    raw = await readBoundedJson(request, 2_048, { signal: deadline.signal });
  } catch (error) {
    return json({ error: error instanceof RequestBodyTooLargeError
      ? 'Invitation request is too large.' : 'Invitation request is invalid.' },
    error instanceof RequestBodyTooLargeError ? 413 : 400);
  } finally {
    deadline.dispose();
  }
  const parsed = InvitationRequestSchema.safeParse(raw);
  if (!parsed.success || !getRoleById(parsed.data.roleId)) {
    return json({ error: 'Choose a supported role and merchant.' }, 400);
  }

  const created = await createProductionInvitation(actorUserId, parsed.data);
  if (!created) return json({ error: 'Invitation could not be created for this workspace.' }, 403);
  const link = new URL('/apply', appOrigin);
  link.searchParams.set('token', created.token);
  return json({
    invitation: {
      id: created.invitation.id,
      expiresAt: created.invitation.expiresAt,
      merchantId: created.invitation.merchantId,
      roleId: created.invitation.roleId,
      url: link.toString(),
    },
  }, 201);
}
