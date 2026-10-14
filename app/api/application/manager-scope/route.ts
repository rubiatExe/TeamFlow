import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server.js';

import {
  listProductionManagerMerchants,
  type ProductionManagerMerchant,
} from '../../../../lib/db/production-application.ts';

const HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: HEADERS });
}

function managerBearer(request: NextRequest): string | null {
  const raw = request.headers.get('authorization');
  const match = raw?.match(/^Bearer ([A-Za-z0-9._-]{20,8192})$/u);
  return match?.[1] ?? null;
}

interface ManagerScopeDependencies {
  verifyUser: (jwt: string) => Promise<string | null>;
  listMerchants: (userId: string) => Promise<ProductionManagerMerchant[]>;
}

export function createProductionManagerScopeGet(deps: ManagerScopeDependencies) {
  return async function GET(request: NextRequest) {
    const jwt = managerBearer(request);
    if (!jwt) return json({ error: 'A manager sign-in is required.' }, 401);

    let userId: string | null;
    try {
      userId = await deps.verifyUser(jwt);
    } catch {
      return json({ error: 'Manager sign-in could not be verified.' }, 503);
    }
    if (!userId) return json({ error: 'A manager sign-in is required.' }, 401);

    try {
      const merchants = await deps.listMerchants(userId);
      return json({ merchants }, 200);
    } catch {
      return json({ error: 'Manager workspaces could not be loaded.' }, 503);
    }
  };
}

async function verifyUser(jwt: string): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Application invitations are not configured.');
  }
  const auth = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const result = await auth.auth.getUser(jwt);
  if (result.error || !result.data.user || result.data.user.is_anonymous) return null;
  return result.data.user.id;
}

export const GET = createProductionManagerScopeGet({
  verifyUser,
  listMerchants: listProductionManagerMerchants,
});
