import { handleInspectResumeReviewRun } from '../../../../lib/http/resume-review-hitl-proxy.ts';

export const maxDuration = 60;

type RouteContext = { params: Promise<{ runId: string }> };

export async function GET(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const { runId } = await params;
  return handleInspectResumeReviewRun(request, runId);
}
