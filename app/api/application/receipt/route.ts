import { NextRequest, NextResponse } from 'next/server.js';
import { z } from 'zod';

import { findSubmittedReceipt } from '../../../../lib/db/production-application.ts';
import { parseApplicationBearer } from '../../../../lib/http/production-application-token.ts';

const HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

export function createProductionReceiptGet(findReceipt: typeof findSubmittedReceipt = findSubmittedReceipt) {
  return async function productionReceiptGet(request: NextRequest) {
    const token = parseApplicationBearer(request.headers);
    const uploadId = z.uuid().safeParse(request.nextUrl.searchParams.get('uploadId'));
    if (!token || !uploadId.success) {
      return NextResponse.json({ success: false }, { status: 401, headers: HEADERS });
    }
    try {
      const receipt = await findReceipt(token, uploadId.data);
      if (!receipt) {
        return NextResponse.json({ success: false }, { status: 404, headers: HEADERS });
      }
      return NextResponse.json({
        success: true,
        applicationId: receipt.applicationId,
        passed: receipt.passed,
        failedKnockouts: [],
      }, { headers: HEADERS });
    } catch {
      return NextResponse.json({ success: false, retryable: true }, { status: 503, headers: HEADERS });
    }
  };
}

export const GET = createProductionReceiptGet();
