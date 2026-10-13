'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronRight,
  ClipboardCheck,
  KeyRound,
  LoaderCircle,
  Quote,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';

import { useToast } from '@/components/ui/toast';
import {
  PendingResumeReviewQueueResponseSchema,
  ResumeReviewDecisionRequestSchema,
  ResumeReviewRunDetailResponseSchema,
} from '@/lib/contracts/resume-review-hitl-api';
import type {
  PendingResumeReviewQueueResponse,
  ResumeReviewRunDetailResponse,
} from '@/lib/contracts/resume-review-hitl';
import {
  scoreCriterion,
  summarizeWeightedScore,
} from '@/lib/domain/scoring-policy';
import { createReviewRequestScope, reviewDecisionMessage } from '@/lib/domain/review-session';

type QueueItem = PendingResumeReviewQueueResponse['items'][number];

const REJECT_REASONS = [
  { code: 'insufficient_evidence', label: 'Not enough evidence' },
  { code: 'role_mismatch', label: 'Wrong role match' },
  { code: 'reviewer_disagrees', label: 'I disagree with the assessment' },
] as const;

const FRIENDLY_ERRORS: Record<number, string> = {
  401: 'That access token was not accepted. Paste a current reviewer session token.',
  403: 'This account is not allowed to review for Cocoa Bakery.',
  404: 'The review service is not enabled for this workspace yet.',
  409: 'Someone already decided this review, or it changed. Refresh the queue.',
  503: 'The review service is unavailable right now. Try again shortly.',
};

function titleCase(code: string): string {
  return code.replace(/[_-]+/g, ' ').replace(/^\w/u, letter => letter.toUpperCase());
}

function relativeTime(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const STATUS_STYLES = {
  met: 'bg-[var(--sage-50)] text-[var(--sage-700)] border-[var(--sage-100)]',
  not_met: 'bg-red-50 text-red-700 border-red-100',
  unknown: 'bg-amber-50 text-amber-800 border-amber-100',
} as const;

export function ReviewQueueTab() {
  const { addToast } = useToast();
  const [tokenDraft, setTokenDraft] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ResumeReviewRunDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState<string>(REJECT_REASONS[0].code);
  const [requests] = useState(createReviewRequestScope);

  useEffect(() => () => requests.reset(), [requests]);

  const authHeaders = useCallback((activeToken: string) => ({ Authorization: `Bearer ${activeToken}` }), []);

  const loadQueue = useCallback(async (activeToken: string) => {
    const request = requests.begin('queue');
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/resume-review-runs?status=pending_review&limit=25', {
        headers: authHeaders(activeToken),
        cache: 'no-store',
        signal: request.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!request.isCurrent()) return;
      if (!response.ok) {
        setError(FRIENDLY_ERRORS[response.status] ?? 'The review queue could not be loaded.');
        setItems(null);
        if (response.status === 401) {
          requests.reset();
          setToken(null);
          setDetail(null);
          setDetailLoading(false);
          setDeciding(false);
          setLoading(false);
        }
        return;
      }
      const parsed = PendingResumeReviewQueueResponseSchema.safeParse(payload);
      if (!parsed.success) {
        setError('The review queue response was not in the expected format.');
        setItems(null);
        return;
      }
      setItems(parsed.data.items);
    } catch {
      if (!request.isCurrent()) return;
      setError('The review service could not be reached.');
      setItems(null);
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [authHeaders, requests]);

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = tokenDraft.trim();
    if (!trimmed) return;
    requests.reset();
    setItems(null);
    setDetail(null);
    setDetailLoading(false);
    setDeciding(false);
    setRejecting(false);
    setToken(trimmed);
    setTokenDraft('');
    await loadQueue(trimmed);
  };

  const disconnect = () => {
    requests.reset();
    setToken(null);
    setItems(null);
    setDetail(null);
    setError(null);
    setLoading(false);
    setDetailLoading(false);
    setDeciding(false);
    setRejecting(false);
  };

  const openRun = async (runId: string) => {
    if (!token || deciding) return;
    const request = requests.begin('detail');
    setDetail(null);
    setDetailLoading(true);
    setRejecting(false);
    try {
      const response = await fetch(`/api/resume-review-runs/${runId}`, { headers: authHeaders(token), cache: 'no-store', signal: request.signal });
      const payload: unknown = await response.json().catch(() => null);
      if (!request.isCurrent()) return;
      const parsed = response.ok ? ResumeReviewRunDetailResponseSchema.safeParse(payload) : null;
      if (!parsed?.success || parsed.data.run_id !== runId) {
        addToast(FRIENDLY_ERRORS[response.status] ?? 'This review could not be opened.', 'error');
        return;
      }
      setDetail(parsed.data);
    } catch {
      if (request.isCurrent()) addToast('The review service could not be reached.', 'error');
    } finally {
      if (request.isCurrent()) setDetailLoading(false);
    }
  };

  const decide = async (action: 'approve' | 'reject') => {
    if (!token || !detail?.review || deciding) return;
    const request = requests.begin('decision');
    setDeciding(true);
    const body = action === 'approve'
      ? { schema_version: '2.0', decision_id: crypto.randomUUID(), review_id: detail.review.review_id, expected_review_version: detail.review.review_version, action }
      : { schema_version: '2.0', decision_id: crypto.randomUUID(), review_id: detail.review.review_id, expected_review_version: detail.review.review_version, action, reason_code: rejectReason };
    const validated = ResumeReviewDecisionRequestSchema.safeParse(body);
    if (!validated.success) {
      addToast('That decision could not be prepared.', 'error');
      setDeciding(false);
      return;
    }
    try {
      const response = await fetch(`/api/resume-review-runs/${detail.run_id}/decision`, {
        method: 'PUT',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(validated.data),
        signal: request.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!request.isCurrent()) return;
      if (!response.ok) {
        addToast(FRIENDLY_ERRORS[response.status] ?? 'The decision could not be recorded.', 'error');
        if (response.status === 409) {
          setDetail(null);
          await loadQueue(token);
        }
        return;
      }
      const outcome = reviewDecisionMessage(payload, detail, action);
      addToast(outcome.message, outcome.type);
      setDetail(null);
      setRejecting(false);
      await loadQueue(token);
    } catch {
      if (request.isCurrent()) addToast('The review service could not be reached. Refresh the queue to check whether your decision was recorded.', 'error');
    } finally {
      if (request.isCurrent()) setDeciding(false);
    }
  };

  const proposal = detail?.proposal;
  const topRole = proposal?.roles[0];
  const scoreSummary = proposal
    ? summarizeWeightedScore(proposal.criterion_details)
    : null;

  return (
    <section aria-labelledby="review-queue-title" className="mx-auto max-w-6xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="cocoa-label">Human in the loop</p>
          <h2 id="review-queue-title" className="mt-2 font-display text-3xl font-semibold text-[var(--cocoa-900)]">Review Queue</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--cocoa-600)]">
            When the AI is unsure about a résumé, it lands here. You see the evidence it quoted, then approve or reject. Nothing is finalized without you.
          </p>
        </div>
        {token ? (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void loadQueue(token)} disabled={loading || deciding} className="inline-flex min-h-10 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--cocoa-300)] bg-white px-3 text-sm font-semibold text-[var(--cocoa-700)] hover:bg-[var(--cocoa-50)] disabled:opacity-60">
              <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /> Refresh
            </button>
            <button type="button" onClick={disconnect} className="inline-flex min-h-10 items-center rounded-[var(--radius-md)] px-3 text-sm font-semibold text-[var(--cocoa-600)] hover:bg-[var(--cocoa-100)]">Disconnect</button>
          </div>
        ) : null}
      </div>

      {!token ? (
        <form onSubmit={connect} className="surface-panel mt-7 max-w-xl p-6">
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-[var(--cocoa-100)] text-[var(--cocoa-700)]"><ShieldCheck className="size-5" aria-hidden="true" /></span>
            <div>
              <h3 className="font-display text-xl font-semibold text-[var(--cocoa-900)]">Sign in to review</h3>
              <p className="text-sm text-[var(--cocoa-600)]">Reviews are private to authorized managers.</p>
            </div>
          </div>
          <label htmlFor="review-token" className="mt-5 block text-sm font-semibold text-[var(--cocoa-800)]">Reviewer access token</label>
          <div className="relative mt-2">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--cocoa-500)]" aria-hidden="true" />
            <input
              id="review-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={tokenDraft}
              onChange={event => setTokenDraft(event.target.value)}
              placeholder="Paste your session token"
              className="min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--cocoa-200)] bg-white pl-10 pr-3 text-sm text-[var(--cocoa-800)] placeholder:text-[var(--cocoa-500)]"
            />
          </div>
          <p className="mt-2 text-xs leading-5 text-[var(--cocoa-600)]">Kept in this tab&apos;s memory only. It is never stored, and closing the tab signs you out.</p>
          {error ? <p role="alert" className="mt-3 rounded-[var(--radius-md)] bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
          <button type="submit" disabled={!tokenDraft.trim() || loading} className="btn-primary mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-md)] px-5 text-sm font-semibold text-white disabled:opacity-60">
            {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <ClipboardCheck className="size-4" aria-hidden="true" />} Open review queue
          </button>
        </form>
      ) : (
        <div className="mt-7 grid gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <div className="surface-panel p-3" aria-live="polite">
            <p className="px-2 pb-2 pt-1 text-xs font-bold uppercase tracking-[0.14em] text-[var(--cocoa-500)]">Waiting for you {items ? `(${items.length})` : ''}</p>
            {error ? <p role="alert" className="m-2 rounded-[var(--radius-md)] bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
            {loading && !items ? <p className="p-4 text-sm text-[var(--cocoa-600)]">Loading reviews…</p> : null}
            {items && items.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-10 text-center">
                <span className="flex size-14 items-center justify-center rounded-full bg-[var(--sage-50)] text-[var(--sage-700)]"><Check className="size-7" aria-hidden="true" /></span>
                <p className="mt-3 font-display text-lg font-semibold text-[var(--cocoa-900)]">You&apos;re all caught up</p>
                <p className="mt-1 text-sm text-[var(--cocoa-600)]">No résumés need a human look right now.</p>
              </div>
            ) : null}
            <ul className="space-y-1.5">
              {items?.map(item => {
                const active = detail?.run_id === item.run_id;
                return (
                  <li key={item.run_id}>
                    <button
                      type="button"
                      onClick={() => void openRun(item.run_id)}
                      disabled={deciding}
                      aria-current={active ? 'true' : undefined}
                      className={`flex w-full items-center gap-3 rounded-[var(--radius-md)] border p-3 text-left transition ${active ? 'border-[var(--cocoa-400)] bg-[var(--cocoa-100)]' : 'border-transparent hover:border-[var(--cocoa-200)] hover:bg-[var(--cocoa-50)]'}`}
                    >
                      <span className="flex size-11 shrink-0 flex-col items-center justify-center rounded-xl bg-white text-[var(--cocoa-800)] shadow-sm">
                        <span className="font-display text-base font-semibold leading-none tabular-nums">{item.top_role.deterministic_score}</span>
                        <span className="text-[9px] font-bold uppercase text-[var(--cocoa-500)]">pts</span>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-[var(--cocoa-900)]">{item.top_role.role_title}</span>
                        <span className="block truncate text-xs text-[var(--cocoa-600)]">{item.reason_codes.length ? titleCase(item.reason_codes[0]) : 'Needs review'} · {relativeTime(item.created_at)}</span>
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-[var(--cocoa-400)]" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="surface-panel min-h-[320px] p-5 sm:p-6">
            {detailLoading ? <p className="text-sm text-[var(--cocoa-600)]">Opening review…</p> : null}
            {!detail && !detailLoading ? (
              <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center">
                <ClipboardCheck className="size-10 text-[var(--cocoa-300)]" strokeWidth={1.5} aria-hidden="true" />
                <p className="mt-3 font-display text-lg font-semibold text-[var(--cocoa-800)]">Pick a review to read</p>
                <p className="mt-1 max-w-xs text-sm text-[var(--cocoa-600)]">Select a résumé on the left to see what the AI found and where it was unsure.</p>
              </div>
            ) : null}

            {detail && proposal && topRole && !detailLoading ? (
              <article aria-label="Review details">
                <header className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="cocoa-label">Best match</p>
                    <h3 className="mt-1 font-display text-2xl font-semibold text-[var(--cocoa-900)]">{topRole.role_title}</h3>
                    <p className="mt-1 text-sm text-[var(--cocoa-600)]">
                      {proposal.recommended_role_id ? 'Recommended role' : 'No single role stood out'} · Policy {topRole.scoring_policy.policy_id} v{topRole.scoring_policy.policy_version}
                    </p>
                  </div>
                  <span className="rounded-2xl bg-[var(--cocoa-100)] px-4 py-2 text-center">
                    <span className="block font-display text-3xl font-semibold leading-none tabular-nums text-[var(--cocoa-800)]">{scoreSummary?.earnedPoints ?? topRole.deterministic_score}</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--cocoa-600)]">Fit score</span>
                  </span>
                </header>

                <section aria-labelledby="role-score-heading" className="mt-6">
                  <div className="flex flex-wrap items-end justify-between gap-2">
                    <div>
                      <h4 id="role-score-heading" className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--cocoa-500)]">Role scores</h4>
                      <p className="mt-1 text-xs leading-5 text-[var(--cocoa-600)]">Each score stays attached to the role and policy used to calculate it.</p>
                    </div>
                    <p className="text-xs text-[var(--cocoa-600)]">Highest score ranks first; ties have no recommendation.</p>
                  </div>
                  <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                    {proposal.roles.map(role => (
                      <li key={role.role_id} className={`rounded-[var(--radius-md)] border p-3 ${role.role_id === proposal.top_role_id ? 'border-[var(--cocoa-300)] bg-[var(--cocoa-50)]' : 'border-[var(--cocoa-100)] bg-white'}`}>
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-[var(--cocoa-900)]">{role.role_title}</p>
                            <p className="truncate text-[11px] text-[var(--cocoa-500)]">{role.scoring_policy.policy_id} · v{role.scoring_policy.policy_version}</p>
                          </div>
                          <span className="font-display text-xl font-semibold tabular-nums text-[var(--cocoa-800)]">{role.deterministic_score}<span className="ml-0.5 text-xs font-medium text-[var(--cocoa-500)]">/100</span></span>
                        </div>
                        {role.recommended ? <p className="mt-2 text-[10px] font-bold uppercase tracking-wide text-[var(--sage-700)]">Recommended</p> : null}
                      </li>
                    ))}
                  </ul>
                </section>

                <section aria-labelledby="score-calculation-heading" className="mt-6 rounded-[var(--radius-md)] border border-[var(--cocoa-200)] bg-white p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h4 id="score-calculation-heading" className="text-sm font-semibold text-[var(--cocoa-900)]">How the {topRole.role_title} score is calculated</h4>
                      <p className="mt-1 max-w-xl text-xs leading-5 text-[var(--cocoa-600)]">Met criteria earn their full configured points. Not met and unknown criteria earn 0. The policy weights must total 100.</p>
                    </div>
                    <p className="shrink-0 text-right text-sm font-semibold tabular-nums text-[var(--cocoa-800)]">
                      {scoreSummary?.earnedPoints ?? topRole.deterministic_score} earned / {scoreSummary?.totalWeight ?? 100} possible
                    </p>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--cocoa-100)]" aria-hidden="true">
                    <span className="block h-full rounded-full bg-[var(--sage-600)]" style={{ width: `${scoreSummary?.earnedPoints ?? topRole.deterministic_score}%` }} />
                  </div>
                  <p className="mt-2 text-[11px] text-[var(--cocoa-500)]">{scoreSummary?.metCriteria ?? 0} of {scoreSummary?.criterionCount ?? proposal.criterion_details.length} criteria met</p>
                </section>

                <h4 className="mt-6 text-xs font-bold uppercase tracking-[0.14em] text-[var(--cocoa-500)]">Scoring criteria and evidence</h4>
                <ul className="mt-3 space-y-3">
                  {proposal.criterion_details.map(criterion => {
                    const earnedPoints = scoreCriterion(criterion);
                    return (
                      <li key={criterion.criterion_id} className="rounded-[var(--radius-md)] border border-[var(--cocoa-100)] bg-[var(--cocoa-50)] p-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-[var(--cocoa-900)]">{criterion.criterion_text}</p>
                            <p className="mt-1 text-xs font-medium tabular-nums text-[var(--cocoa-600)]">{earnedPoints} of {criterion.weight} points earned</p>
                          </div>
                          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-bold ${STATUS_STYLES[criterion.status]}`}>{criterion.status === 'not_met' ? 'Not met' : titleCase(criterion.status)}</span>
                        </div>
                        {criterion.evidence_snippets.map(snippet => (
                          <blockquote key={`${snippet.source_block_id}-${snippet.exact_quote}`} className="mt-2 flex gap-2 border-l-2 border-[var(--cocoa-300)] pl-3 text-sm italic text-[var(--cocoa-700)]">
                            <Quote className="mt-0.5 size-3.5 shrink-0 text-[var(--cocoa-400)]" aria-hidden="true" />
                            <span>{snippet.exact_quote}</span>
                          </blockquote>
                        ))}
                      </li>
                    );
                  })}
                </ul>

                <aside className="mt-5 rounded-[var(--radius-md)] bg-[var(--cocoa-50)] px-3 py-2 text-xs leading-5 text-[var(--cocoa-600)]">
                  <strong className="text-[var(--cocoa-800)]">Evidence coverage:</strong> {proposal.confidence.score}/100 ({titleCase(proposal.confidence.status)}). This diagnostic checks whether the evidence is complete enough to review; it is not the candidate&apos;s fit score and does not change the weighted total.
                </aside>

                {proposal.question_plan?.questions.length ? (
                  <>
                    <h4 className="mt-6 text-xs font-bold uppercase tracking-[0.14em] text-[var(--cocoa-500)]">Suggested follow-up questions</h4>
                    <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-[var(--cocoa-800)]">
                      {proposal.question_plan.questions.map(question => <li key={question.target_criterion_id}>{question.question}</li>)}
                    </ol>
                  </>
                ) : null}

                {proposal.limitations.length ? (
                  <p className="mt-6 rounded-[var(--radius-md)] bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                    <strong>Limits of this review:</strong> {proposal.limitations.join(' ')}
                  </p>
                ) : null}

                <footer className="mt-6 border-t border-[var(--cocoa-100)] pt-5">
                  {rejecting ? (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                      <div className="flex-1">
                        <label htmlFor="reject-reason" className="block text-sm font-semibold text-[var(--cocoa-800)]">Why are you rejecting this?</label>
                        <select id="reject-reason" disabled={deciding} value={rejectReason} onChange={event => setRejectReason(event.target.value)} className="mt-2 min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--cocoa-200)] bg-white px-3 text-sm text-[var(--cocoa-800)]">
                          {REJECT_REASONS.map(reason => <option key={reason.code} value={reason.code}>{reason.label}</option>)}
                        </select>
                      </div>
                      <button type="button" disabled={deciding} onClick={() => setRejecting(false)} className="min-h-11 rounded-[var(--radius-md)] border border-[var(--cocoa-300)] px-4 text-sm font-semibold text-[var(--cocoa-700)] hover:bg-[var(--cocoa-50)]">Cancel</button>
                      <button type="button" disabled={deciding} onClick={() => void decide('reject')} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60">
                        {deciding ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <X className="size-4" aria-hidden="true" />} Confirm reject
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-end gap-3">
                      <button type="button" disabled={deciding} onClick={() => setRejecting(true)} className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 hover:bg-red-50">
                        <X className="size-4" aria-hidden="true" /> Reject
                      </button>
                      <button type="button" disabled={deciding} onClick={() => void decide('approve')} className="btn-primary inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] px-5 text-sm font-semibold text-white disabled:opacity-60">
                        {deciding ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Check className="size-4" aria-hidden="true" />} Approve assessment
                      </button>
                    </div>
                  )}
                </footer>
              </article>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
