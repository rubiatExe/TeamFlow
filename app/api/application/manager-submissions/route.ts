import { NextRequest, NextResponse } from 'next/server.js';

import {
  listManagerSubmissions,
  type ManagerSubmissionPage,
} from '../../../../lib/db/production-manager-submissions.ts';
import { parseManagerBearer, verifyProductionManagerJwt } from '../../../../lib/http/production-manager-auth.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: HEADERS });
}

type Dependencies = {
  verifyUser: typeof verifyProductionManagerJwt;
  listSubmissions: (userId: string, merchantId: string, page: number) => Promise<ManagerSubmissionPage | null>;
};

export function createManagerSubmissionsGet(deps: Dependencies) {
  return async function GET(request: NextRequest) {
    const jwt = parseManagerBearer(request.headers);
    if (!jwt) return json({ error: 'A manager sign-in is required.' }, 401);
    let actorUserId: string | null;
    try { actorUserId = await deps.verifyUser(jwt); }
    catch { return json({ error: 'Manager sign-in could not be verified.' }, 503); }
    if (!actorUserId) return json({ error: 'A manager sign-in is required.' }, 401);

    const merchantId = request.nextUrl.searchParams.get('merchantId');
    const pageText = request.nextUrl.searchParams.get('page') ?? '0';
    const page = Number(pageText);
    if (!merchantId || !UUID_RE.test(merchantId) || !/^\d{1,3}$/u.test(pageText)
      || !Number.isInteger(page) || page < 0 || page > 100) {
      return json({ error: 'Choose a valid workspace and page.' }, 400);
    }
    try {
      const result = await deps.listSubmissions(actorUserId, merchantId, page);
      if (!result) return json({ error: 'You cannot view applications in this workspace.' }, 403);
      return json(result, 200);
    } catch {
      return json({ error: 'Applications could not be loaded. Try again.' }, 503);
    }
  };
}

export const GET = createManagerSubmissionsGet({
  verifyUser: verifyProductionManagerJwt,
  listSubmissions: listManagerSubmissions,
});
