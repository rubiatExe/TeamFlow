import { createResumePreviewPost } from './handler';
import { createProductionResumePreviewPost } from '../production-handler';
import { legacyDemoRoutesEnabled } from '@/lib/http/legacy-demo-route';
import type { NextRequest } from 'next/server';

export const maxDuration = 60;

const demoPost = createResumePreviewPost();
const productionPost = createProductionResumePreviewPost();

export function POST(request: NextRequest) {
  return legacyDemoRoutesEnabled() ? demoPost(request) : productionPost(request);
}
