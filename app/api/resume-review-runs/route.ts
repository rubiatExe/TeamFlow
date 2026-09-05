import {
  handleListPendingResumeReviews,
  handleStartResumeReviewRun,
} from '../../../lib/http/resume-review-hitl-proxy.ts';

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleStartResumeReviewRun(request);
}

export async function GET(request: Request): Promise<Response> {
  return handleListPendingResumeReviews(request);
}
