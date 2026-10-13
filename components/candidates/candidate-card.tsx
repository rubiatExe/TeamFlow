'use client';

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useId,
  useRef,
  useState,
} from 'react';
import {
  Check,
  ChevronDown,
  LoaderCircle,
  MapPin,
  Phone,
  Trash2,
  X,
} from 'lucide-react';

import { CandidateAvatar } from '@/components/candidates/candidate-avatar';
import { ApplicationStatus } from '@/components/candidates/application-status';
import { CriterionAssessment } from '@/components/search/criterion-assessment';
import type { ManagerCriteriaCandidateResult } from '@/lib/contracts/manager-criteria';
import type { CandidateCardData, CandidateStatus } from '@/lib/contracts/candidate';
import { getRoleById } from '@/lib/domain/roles';
import { getDemoProfile } from '@/lib/domain/demo-workspace';
import { scoreCriterion } from '@/lib/domain/scoring-policy';
import { criteriaBaseScore } from '@/lib/domain/criteria-presentation';

type CandidateActionResult = { ok: true } | { ok: false; message: string };

interface CandidateCardProps {
  candidateId: string;
  data: CandidateCardData;
  status: CandidateStatus;
  index?: number;
  debugMode?: boolean;
  addedAssessment?: ManagerCriteriaCandidateResult;
  onAdvance?: (candidateId: string, nextStatus: CandidateStatus) => Promise<CandidateActionResult> | CandidateActionResult;
  onStatusChange?: (candidateId: string, nextStatus: CandidateStatus) => Promise<void> | void;
  onRemove?: (candidateId: string) => Promise<void> | void;
}

const STATUS_STYLES: Record<CandidateStatus, string> = {
  pending: 'bg-[var(--status-pending-bg)] text-[var(--status-pending)]',
  new: 'bg-[var(--status-new-bg)] text-[var(--status-new)]',
  invited: 'bg-[var(--status-invited-bg)] text-[var(--status-invited)]',
  interviewed: 'bg-[var(--status-interviewed-bg)] text-[var(--status-interviewed)]',
  hired: 'bg-[var(--status-hired-bg)] text-[var(--status-hired)]',
};

const STATUS_LABELS: Record<CandidateStatus, string> = {
  pending: 'Pending review',
  new: 'New',
  invited: 'Invited',
  interviewed: 'Interviewed',
  hired: 'Hired',
};

const ALL_STATUSES: CandidateStatus[] = ['pending', 'new', 'invited', 'interviewed', 'hired'];

function nextStatusFor(status: CandidateStatus): CandidateStatus | null {
  if (status === 'pending' || status === 'new') return 'invited';
  if (status === 'invited') return 'interviewed';
  if (status === 'interviewed') return 'hired';
  return null;
}

function actionLabel(status: CandidateStatus, firstName: string, simulated = false): string {
  if (status === 'pending' || status === 'new') return simulated ? 'Simulate Interview Invite' : 'Send Interview Invite';
  if (status === 'invited') return 'Mark as Interviewed';
  if (status === 'interviewed') return simulated ? 'Mark as Hired' : `Hire ${firstName}`;
  return 'On the team';
}

export function CandidateCard({
  candidateId,
  data,
  status,
  index = 0,
  debugMode = false,
  addedAssessment,
  onAdvance,
  onStatusChange,
  onRemove,
}: CandidateCardProps) {
  const { candidate, score, red_flags: redFlags } = data;
  const approvedPolicy = score.approved_policy;
  const samplePolicy = score.calculation === 'sample_policy' ? score.sample_policy : undefined;
  const weightedPolicy = approvedPolicy ?? samplePolicy;
  const calculation = score.calculation ?? 'legacy_preview';
  const demoProfile = getDemoProfile(candidateId);
  const simulated = Boolean(demoProfile) || candidateId.startsWith('demo_') || candidateId.startsWith('local_');
  const scorePopoverId = useId();
  const touchStartXRef = useRef<number | null>(null);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [actionState, setActionState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [actionError, setActionError] = useState('');
  const [swipeX, setSwipeX] = useState(0);

  const role = candidate.applied_role ? getRoleById(candidate.applied_role) : undefined;
  const firstName = candidate.name.trim().split(/\s+/u)[0] || candidate.name;
  const nextStatus = nextStatusFor(status);
  const remainingSkills = candidate.skills.slice(4);
  const actionDisabled = actionState === 'loading' || status === 'hired' || !nextStatus || !onAdvance;

  const runAdvance = async () => {
    if (!nextStatus || !onAdvance || actionState === 'loading') return;
    setActionState('loading');
    setActionError('');
    const startedAt = performance.now();
    const result = await onAdvance(candidateId, nextStatus);
    const elapsed = performance.now() - startedAt;
    if (elapsed < 200) await new Promise(resolve => setTimeout(resolve, 200 - elapsed));
    if (!result.ok) {
      setActionState('error');
      setActionError(result.message);
      return;
    }
    setActionState('success');
    setTimeout(() => setActionState('idle'), 1_500);
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') setScoreOpen(false);
    if (event.currentTarget !== event.target) return;
    if ((event.key === 'Enter' || event.key === ' ') && !actionDisabled) {
      event.preventDefault();
      void runAdvance();
    }
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return;
    if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea, summary')) return;
    touchStartXRef.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' || touchStartXRef.current === null) return;
    const delta = event.clientX - touchStartXRef.current;
    const maxRight = nextStatus && onAdvance ? 84 : 0;
    setSwipeX(Math.max(-84, Math.min(maxRight, delta)));
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' || touchStartXRef.current === null) return;
    touchStartXRef.current = null;
    if (swipeX <= -52 && onRemove) setSwipeX(-84);
    else if (swipeX >= 52 && nextStatus && onAdvance) setSwipeX(84);
    else setSwipeX(0);
  };

  const primaryClass = status === 'interviewed'
    ? 'bg-[var(--sage-600)] text-white hover:bg-[var(--sage-700)]'
    : status === 'invited'
      ? 'border border-[var(--cocoa-700)] bg-white text-[var(--cocoa-700)] hover:bg-[var(--cocoa-50)]'
      : status === 'hired'
        ? 'bg-[var(--sage-50)] text-[var(--sage-700)]'
        : 'bg-[var(--cocoa-700)] text-white hover:bg-[var(--cocoa-600)]';

  return (
    <div className="candidate-card-enter relative overflow-hidden rounded-[var(--radius-lg)] md:overflow-visible" style={{ '--card-delay': `${index * 50}ms` } as CSSProperties}>
      {nextStatus && onAdvance ? (
        <div className="absolute inset-y-0 left-0 flex w-[84px] items-center justify-center bg-[var(--sage-600)] text-white md:hidden">
          <button
            type="button"
            className="flex h-full w-full flex-col items-center justify-center gap-1 text-xs font-semibold"
            onClick={() => { setSwipeX(0); void runAdvance(); }}
            aria-label={`${actionLabel(status, firstName, simulated)} for ${candidate.name}`}
          >
            <Phone className="size-5" aria-hidden="true" />
            {status === 'pending' || status === 'new' ? simulated ? 'Demo invite' : 'Invite' : status === 'invited' ? 'Interview' : 'Hire'}
          </button>
        </div>
      ) : null}
      <div className="absolute inset-y-0 right-0 flex w-[84px] items-center justify-center bg-red-700 text-white md:hidden">
        <button
          type="button"
          className="flex h-full w-full flex-col items-center justify-center gap-1 text-xs font-semibold"
          onClick={() => { setSwipeX(0); setRemoveConfirm(true); }}
          aria-label={`Remove ${candidate.name}`}
        >
          <Trash2 className="size-5" aria-hidden="true" />
          Remove
        </button>
      </div>

      <div
        className="relative touch-pan-y bg-white transition-transform duration-200 md:[transform:translateX(0)!important]"
        style={{ transform: `translateX(${swipeX}px)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => { touchStartXRef.current = null; setSwipeX(0); }}
      >
        <article
          tabIndex={0}
          data-candidate-card
          onKeyDown={handleCardKeyDown}
          aria-label={`${candidate.name}, ${STATUS_LABELS[status]}, ${score.total === null ? 'awaiting review' : `${samplePolicy ? 'sample score' : 'fit score'} ${score.total}`}`}
          className="group relative min-h-[200px] rounded-[var(--radius-lg)] border border-[var(--cocoa-100)] bg-white p-4 shadow-[var(--shadow-card)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-card-hover)] focus-visible:-translate-y-0.5 focus-visible:shadow-[var(--shadow-card-hover)] sm:p-5"
        >
          <div className="flex items-start justify-between gap-3">
            <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_STYLES[status]}`}>
              {STATUS_LABELS[status]}
            </span>

            {onRemove ? (
              removeConfirm ? (
                <div className="relative z-20 flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 p-1 text-[11px] font-semibold text-red-800 shadow-sm">
                  <span className="px-1">Remove?</span>
                  <button type="button" className="min-h-8 rounded-md bg-red-700 px-2 text-white" onClick={() => void onRemove(candidateId)}>Yes</button>
                  <button type="button" className="min-h-8 rounded-md bg-white px-2" onClick={() => setRemoveConfirm(false)}>No</button>
                </div>
              ) : (
                <button
                  type="button"
                  aria-label={`Remove ${candidate.name}`}
                  onClick={() => setRemoveConfirm(true)}
                  className="relative z-10 flex size-8 items-center justify-center rounded-lg text-[var(--cocoa-500)] opacity-100 transition hover:bg-red-50 hover:text-red-700 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              )
            ) : null}
          </div>

          <div className="mt-3 flex items-start gap-3 text-left">
            <div className="hidden min-[420px]:block"><CandidateAvatar name={candidate.name} /></div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <h4 className="min-w-0 pt-1 font-display text-lg font-semibold leading-tight text-[var(--cocoa-900)]">{candidate.name}</h4>
                {score.total === null ? (
                  <span className="max-w-20 shrink-0 rounded-lg bg-[var(--cocoa-50)] px-2 py-1 text-center text-[10px] font-semibold text-[var(--cocoa-600)]">Awaiting review</span>
                ) : (
                  <button
                    type="button"
                    aria-label={`${samplePolicy ? 'Sample' : approvedPolicy ? 'Approved fit' : 'Fit'} score for ${candidate.name}: ${score.total} out of 100. ${scoreOpen ? 'Hide' : 'Show'} criterion contributions.`}
                    aria-expanded={scoreOpen}
                    aria-controls={scorePopoverId}
                    onClick={() => setScoreOpen(previous => !previous)}
                    className="min-h-14 min-w-20 shrink-0 rounded-xl border border-[var(--cocoa-200)] bg-[var(--cocoa-50)] px-2 py-1.5 text-center text-[var(--cocoa-800)] transition hover:border-[var(--cocoa-500)] hover:bg-[var(--cocoa-100)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cocoa-600)]"
                  >
                    <span className="block leading-none"><span className="text-2xl font-bold tabular-nums">{score.total}</span><span className="ml-0.5 text-[10px] font-medium text-[var(--cocoa-500)]">/100</span></span>
                    <span className="mt-1 flex items-center justify-center gap-0.5 text-[10px] font-semibold">
                      {samplePolicy ? 'Sample score' : approvedPolicy ? 'Policy score' : calculation === 'legacy_preview' ? 'Legacy preview' : 'Score details'}
                      <ChevronDown aria-hidden="true" className={`size-3 transition-transform ${scoreOpen ? 'rotate-180' : ''}`} />
                    </span>
                  </button>
                )}
              </div>
              <p className="mt-1 text-xs font-semibold text-[var(--cocoa-700)]">
                {candidate.applied_role_title ?? (role ? `${role.emoji} ${role.title}` : candidate.applied_role || 'Open role')}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-[var(--cocoa-600)]">
                {candidate.city ? <><MapPin className="size-3" aria-hidden="true" />{candidate.city}</> : 'Location not listed'}
                <span aria-hidden="true">•</span>
                {candidate.experience_years ?? 0} yrs exp
              </p>
              {demoProfile ? (
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-amber-800">Fictional sample · demo stages</p>
              ) : debugMode && candidateId.startsWith('demo_') ? (
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-amber-800">Synthetic preview record</p>
              ) : null}
            </div>
          </div>

          <div className="mt-3"><ApplicationStatus application={data.application} sample={simulated} /></div>
          {addedAssessment && addedAssessment.base_score === criteriaBaseScore(data, Boolean(demoProfile)) ? (
            <div className="mt-3"><CriterionAssessment assessment={addedAssessment} sample={Boolean(demoProfile)} /></div>
          ) : null}

          {scoreOpen && score.total !== null ? (
            <section
              id={scorePopoverId}
              aria-label={`Score breakdown for ${candidate.name}`}
              className="mt-4 min-w-0 rounded-[var(--radius-md)] bg-[var(--cocoa-900)] p-4 text-left text-white [overflow-wrap:anywhere]"
            >
              <p className="font-semibold">
                {samplePolicy
                  ? 'Sample score breakdown'
                  : approvedPolicy
                    ? 'Approved weighted score'
                    : calculation === 'legacy_preview'
                      ? 'Legacy preview score'
                      : 'Score details unavailable'}
              </p>
              {weightedPolicy ? (
                <>
                  <p className="mt-1 text-xs leading-5 text-white/75">{weightedPolicy.role_title} · {weightedPolicy.policy_id} v{weightedPolicy.policy_version}</p>
                  <p className="mt-3 text-xs leading-5 text-white/80">Each met criterion adds its full weight to the total. Not met and unknown criteria add 0 points.</p>
                  <p className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-white/60">Criterion · earned / possible points</p>
                  <dl className="mt-2 space-y-3 border-t border-white/20 pt-3 text-xs">
                    {weightedPolicy.criteria.map(criterion => (
                      <div key={criterion.criterion_id}>
                        <div className="flex items-start justify-between gap-3">
                          <dt className="min-w-0">
                            <span className="block leading-4">{criterion.criterion_text}</span>
                            <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-wide text-white/60">{criterion.status === 'not_met' ? 'Not met' : criterion.status === 'unknown' ? 'Not evidenced' : 'Met'}</span>
                          </dt>
                          <dd className="shrink-0 text-right font-semibold tabular-nums">
                            <span className="block">+{scoreCriterion(criterion)} pts</span>
                            <span className="mt-0.5 block text-[10px] font-normal text-white/60">of {criterion.weight} possible</span>
                          </dd>
                        </div>
                        <div aria-hidden="true" className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
                          <div className="absolute h-full rounded-full bg-white/20" style={{ width: `${criterion.weight}%` }} />
                          <div className="absolute h-full rounded-full bg-[var(--sage-500)]" style={{ width: `${scoreCriterion(criterion)}%` }} />
                        </div>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-3 border-t border-white/20 pt-3 text-xs font-semibold tabular-nums">{weightedPolicy.criteria.map(criterion => scoreCriterion(criterion)).join(' + ')} = {score.total}/100</p>
                </>
              ) : calculation === 'legacy_preview' ? (
                <dl className="mt-3 space-y-1.5 text-xs">
                  <div className="flex justify-between gap-4"><dt>Constraints</dt><dd>{score.breakdown.constraints}/50</dd></div>
                  <div className="flex justify-between gap-4"><dt>Experience</dt><dd>{score.breakdown.experience}/30</dd></div>
                  <div className="flex justify-between gap-4"><dt>Logistics</dt><dd>{score.breakdown.logistics}/20</dd></div>
                </dl>
              ) : (
                <p className="mt-3 text-xs leading-5 text-white/80">The approved total is available, but its matching policy details could not be verified. No breakdown is shown.</p>
              )}
              <p className="mt-3 border-t border-white/20 pt-3 text-xs italic leading-5 text-white/80">{score.explanation}</p>
            </section>
          ) : null}

          {candidate.skills.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-1.5 border-t border-[var(--cocoa-100)] pt-3" aria-label="Candidate skills">
              {candidate.skills.slice(0, 4).map(skill => (
                <span key={skill} className="rounded-[var(--radius-sm)] bg-[var(--cocoa-100)] px-2.5 py-1 text-[11px] font-medium text-[var(--cocoa-700)]">{skill}</span>
              ))}
              {remainingSkills.length > 0 ? (
                <span className="group/more relative">
                  <button type="button" className="rounded-[var(--radius-sm)] border border-[var(--cocoa-200)] bg-white px-2.5 py-1 text-[11px] font-medium text-[var(--cocoa-600)]">
                    +{remainingSkills.length} more
                  </button>
                  <span role="tooltip" className="pointer-events-none absolute bottom-[calc(100%+8px)] left-0 z-20 hidden w-44 rounded-lg bg-[var(--cocoa-900)] p-2 text-xs leading-5 text-white shadow-lg group-hover/more:block group-focus-within/more:block">
                    {remainingSkills.join(' · ')}
                  </span>
                </span>
              ) : null}
            </div>
          ) : null}

          {demoProfile ? (
            <details className="mt-4 rounded-[var(--radius-md)] border border-[var(--cocoa-100)] bg-[var(--cocoa-50)] p-3 text-xs text-[var(--cocoa-700)]">
              <summary className="min-h-6 cursor-pointer font-semibold">Read sample résumé</summary>
              <p className="mt-2 font-medium">{demoProfile.headline}</p>
              {demoProfile.sourceBlocks.map(block => (
                <figure key={block.sourceBlockId} className="mt-3">
                  <blockquote className="leading-5">“{block.text}”</blockquote>
                  <figcaption className="mt-1 text-[10px] text-[var(--cocoa-500)]">{block.section} · block {block.blockNumber}</figcaption>
                </figure>
              ))}
            </details>
          ) : null}

          {redFlags.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[var(--cocoa-100)] pt-3">
              {redFlags.map(flag => (
                <span key={flag} className="rounded-[var(--radius-sm)] bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700">⚠️ {flag}</span>
              ))}
            </div>
          ) : null}

          <button
            type="button"
            disabled={actionDisabled}
            onClick={() => void runAdvance()}
            className={`mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-md)] px-4 text-sm font-semibold shadow-sm transition active:scale-[0.97] disabled:cursor-default disabled:opacity-80 ${primaryClass}`}
          >
            {actionState === 'loading' ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
            {actionState === 'success' || status === 'hired' ? <Check className="size-4" aria-hidden="true" /> : null}
            {actionState === 'success' ? 'Updated' : actionLabel(status, firstName, simulated)}
          </button>

          {actionError ? <p role="alert" className="mt-2 text-xs text-red-700">{actionError}</p> : null}

          {status !== 'hired' && onStatusChange ? (
            <div className="relative mt-2 text-center">
              <span className="sr-only" id={`status-label-${candidateId}`}>Change status for {candidate.name}</span>
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={statusMenuOpen}
                aria-labelledby={`status-label-${candidateId}`}
                onClick={() => setStatusMenuOpen(open => !open)}
                className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium text-[var(--cocoa-600)] hover:bg-[var(--cocoa-50)] hover:underline"
              >
                Change status <ChevronDown className="size-3" aria-hidden="true" />
              </button>
              {statusMenuOpen ? (
                <div role="menu" className="absolute bottom-10 left-1/2 z-20 w-44 -translate-x-1/2 overflow-hidden rounded-[var(--radius-md)] border border-[var(--cocoa-200)] bg-white p-1 text-left shadow-lg">
                  {ALL_STATUSES.map(option => (
                    <button
                      key={option}
                      type="button"
                      role="menuitem"
                      disabled={option === status}
                      onClick={() => {
                        setStatusMenuOpen(false);
                        if (option !== status) void onStatusChange(candidateId, option);
                      }}
                      className="flex min-h-10 w-full items-center rounded-lg px-3 text-xs font-medium text-[var(--cocoa-800)] hover:bg-[var(--cocoa-100)] disabled:bg-[var(--cocoa-50)] disabled:text-[var(--cocoa-500)]"
                    >
                      {STATUS_LABELS[option]}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </article>
      </div>
    </div>
  );
}

export type { CandidateActionResult };
