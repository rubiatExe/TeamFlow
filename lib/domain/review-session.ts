import { ResumeReviewRunResponseSchema, type ResumeReviewRunDetailResponse } from '../contracts/resume-review-hitl.ts';

/** Invalidate in-flight data when changing reviewer sessions or selected reviews. */
export function createReviewRequestScope() {
  const active = new Map<string, AbortController>();
  return {
    begin(channel: 'queue' | 'detail' | 'decision') {
      active.get(channel)?.abort();
      const controller = new AbortController();
      active.set(channel, controller);
      return {
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted && active.get(channel) === controller,
      };
    },
    reset() {
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
  };
}

export function reviewDecisionMessage(
  payload: unknown,
  detail: ResumeReviewRunDetailResponse,
  action: 'approve' | 'reject',
): { message: string; type: 'success' | 'warning' | 'error' } {
  const parsed = ResumeReviewRunResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.run_id !== detail.run_id
    || parsed.data.request_id !== detail.request_id || parsed.data.document_id !== detail.document_id
    || parsed.data.review?.review_id !== detail.review?.review_id) {
    return { message: 'The decision response could not be verified. Refresh the queue before trying again.', type: 'error' };
  }
  if (parsed.data.status === 'completed' && action === 'approve') {
    return { message: 'Review approved. The assessment is now final.', type: 'success' };
  }
  if (parsed.data.status === 'rejected' && action === 'reject') {
    return { message: 'Review rejected and recorded.', type: 'success' };
  }
  if (action === 'approve' && ['decision_recorded', 'applying'].includes(parsed.data.status)) {
    return { message: 'Approval recorded. The assessment is still being applied; refresh before using its score.', type: 'warning' };
  }
  return { message: 'The assessment was not finalized. Refresh the queue to check its current state.', type: 'error' };
}
