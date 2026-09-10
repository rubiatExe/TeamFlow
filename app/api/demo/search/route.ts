import type { NextRequest } from 'next/server';

import { handleDemoSemanticSearchRequest } from '@/lib/http/demo-semantic-search-route';

export const runtime = 'nodejs';
export const maxDuration = 15;

export async function POST(request: NextRequest) {
  return handleDemoSemanticSearchRequest(request);
}
