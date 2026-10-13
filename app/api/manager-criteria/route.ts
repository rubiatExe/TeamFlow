import { DEMO_MERCHANT_ID } from '@/lib/db/supabase';
import { handleManagerCriteriaRequest } from '@/lib/http/manager-criteria-route';

export const runtime = 'nodejs';
export const maxDuration = 70;

export async function POST(request: Request) {
  return handleManagerCriteriaRequest(request, { merchantId: DEMO_MERCHANT_ID });
}
