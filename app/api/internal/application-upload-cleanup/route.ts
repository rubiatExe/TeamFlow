import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

import {
  claimAbandonedUploadGrant,
  deleteAbandonedUploadGrant,
  listAbandonedUploadGrants,
} from '../../../../lib/db/production-application.ts';
import { deleteResume } from '../../../../lib/db/storage.ts';

export const maxDuration = 60;
const BATCH_SIZE = 50;
const MAX_BATCHES = 10;
const WORK_BUDGET_MS = 45_000;

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: HEADERS });
  }

  try {
    // Signed upload capabilities expire after two hours. Wait three hours so
    // cleanup never races a still-valid browser upload. The DB also keeps
    // every unsubmitted file until its invitation has expired.
    const beforeIso = new Date(Date.now() - 3 * 60 * 60 * 1_000).toISOString();
    const startedAt = Date.now();
    let checked = 0;
    let removed = 0;
    let failed = 0;
    let incomplete = false;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      if (Date.now() - startedAt >= WORK_BUDGET_MS) {
        incomplete = true;
        break;
      }
      const grants = await listAbandonedUploadGrants(beforeIso, BATCH_SIZE);
      checked += grants.length;
      if (grants.length === 0) break;
      for (const grant of grants) {
        if (Date.now() - startedAt >= WORK_BUDGET_MS) {
          incomplete = true;
          break;
        }
        const path = await claimAbandonedUploadGrant(grant.id);
        if (!path) continue;
        if (!await deleteResume(path) || !await deleteAbandonedUploadGrant(grant.id)) {
          failed += 1;
          continue;
        }
        removed += 1;
      }
      if (failed || incomplete || grants.length < BATCH_SIZE) break;
      if (batch === MAX_BATCHES - 1) incomplete = true;
    }
    return Response.json(
      { checked, removed, failed, incomplete },
      { status: failed || incomplete ? 503 : 200, headers: HEADERS },
    );
  } catch {
    return Response.json({ error: 'Cleanup unavailable' }, { status: 503, headers: HEADERS });
  }
}
