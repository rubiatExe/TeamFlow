import type { NextRequest } from 'next/server';

import { DEMO_MERCHANT_ID } from '@/lib/db/supabase';
import { handleHiringAgentRequest } from '@/lib/http/hiring-agent-route';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return handleHiringAgentRequest(req, { merchantId: DEMO_MERCHANT_ID });
}
