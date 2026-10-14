import { createApplicationPost } from './handler';
import { createProductionApplicationPost } from './production-handler';
import { legacyDemoRoutesEnabled } from '@/lib/http/legacy-demo-route';
import type { NextRequest } from 'next/server';

export const maxDuration = 60;

const demoPost = createApplicationPost();
const productionPost = createProductionApplicationPost();

export function POST(request: NextRequest) {
  return legacyDemoRoutesEnabled() ? demoPost(request) : productionPost(request);
}
