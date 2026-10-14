import { NextRequest, NextResponse } from 'next/server.js';

import { createManagerResumeUrl } from '../../../../lib/db/production-manager-submissions.ts';
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
  createResumeUrl: typeof createManagerResumeUrl;
};

export function createManagerResumeGet(deps: Dependencies) {
  return async function GET(request: NextRequest) {
    const jwt = parseManagerBearer(request.headers);
    if (!jwt) return json({ error: 'A manager sign-in is required.' }, 401);
    let actorUserId: string | null;
    try { actorUserId = await deps.verifyUser(jwt); }
    catch { return json({ error: 'Manager sign-in could not be verified.' }, 503); }
    if (!actorUserId) return json({ error: 'A manager sign-in is required.' }, 401);

    const merchantId = request.nextUrl.searchParams.get('merchantId');
    const applicationId = request.nextUrl.searchParams.get('applicationId');
    if (!merchantId || !UUID_RE.test(merchantId) || !applicationId || !UUID_RE.test(applicationId)) {
      return json({ error: 'Choose a valid application.' }, 400);
    }
    try {
      const url = await deps.createResumeUrl(actorUserId, merchantId, applicationId);
      if (!url) return json({ error: 'Résumé unavailable for this workspace.' }, 404);
      return json({ url, expiresInSeconds: 60 }, 200);
    } catch {
      return json({ error: 'Résumé could not be opened. Try again.' }, 503);
    }
  };
}

export const GET = createManagerResumeGet({
  verifyUser: verifyProductionManagerJwt,
  createResumeUrl: createManagerResumeUrl,
});
