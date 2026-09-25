'use client';

import type { KeyboardEvent } from 'react';
import { Inbox, Sparkles, UserCheck } from 'lucide-react';

import { CandidateCard, type CandidateActionResult } from '@/components/candidates/candidate-card';
import type { CandidateStatus, CandidateWithStatus } from '@/lib/contracts/candidate';

export type StageVisibility = {
  new: boolean;
  invited: boolean;
  interviewed: boolean;
};

interface CandidateBoardProps {
  candidates: CandidateWithStatus[];
  stageVisibility: StageVisibility;
  debugMode?: boolean;
  onAdvance?: (candidateId: string, nextStatus: CandidateStatus) => Promise<CandidateActionResult> | CandidateActionResult;
  onStatusChange?: (candidateId: string, nextStatus: CandidateStatus) => Promise<void> | void;
  onRemove?: (candidateId: string) => Promise<void> | void;
  onUpload?: () => void;
}

type Lane = {
  key: 'review' | 'progress' | 'hired';
  label: string;
  emoji: string;
  statuses: CandidateStatus[];
  border: string;
};

const LANES: Lane[] = [
  { key: 'review', label: 'To Review', emoji: '🆕', statuses: ['pending', 'new'], border: 'border-l-[var(--status-new)]' },
  { key: 'progress', label: 'In Progress', emoji: '📧', statuses: ['invited', 'interviewed'], border: 'border-l-[var(--status-invited)]' },
  { key: 'hired', label: 'Hired Team', emoji: '🎉', statuses: ['hired'], border: 'border-l-[var(--sage-600)]' },
];

function EmptyLane({ lane, hasCandidates, onUpload }: { lane: Lane; hasCandidates: boolean; onUpload?: () => void }) {
  if (lane.key === 'review') {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center px-3 py-8 text-center">
        <Inbox className="size-10 text-[var(--cocoa-300)]" strokeWidth={1.5} aria-hidden="true" />
        <p className="mt-3 text-sm font-medium text-[var(--cocoa-700)]">
          {hasCandidates ? 'No applicants match these filters.' : 'No new applicants yet.'}
        </p>
        <p className="mt-1 text-xs leading-5 text-[var(--cocoa-600)]">
          {hasCandidates ? 'Lower the minimum score or restore the New stage.' : 'Upload résumés or share your application link.'}
        </p>
        {!hasCandidates && onUpload ? (
          <button type="button" onClick={onUpload} className="mt-4 min-h-10 rounded-[var(--radius-md)] bg-[var(--cocoa-700)] px-4 text-xs font-semibold text-white hover:bg-[var(--cocoa-600)]">
            Upload Resumes →
          </button>
        ) : null}
      </div>
    );
  }

  if (lane.key === 'progress') {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center px-4 py-8 text-center">
        <Sparkles className="size-9 text-[var(--cocoa-300)]" strokeWidth={1.5} aria-hidden="true" />
        <p className="mt-3 text-sm font-medium text-[var(--cocoa-700)]">No one here yet.</p>
        <p className="mt-1 text-xs leading-5 text-[var(--cocoa-600)]">Ready to invite? Your top-rated candidates are in To Review.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-48 flex-col items-center justify-center px-4 py-8 text-center">
      <UserCheck className="size-9 text-[var(--sage-500)]" strokeWidth={1.5} aria-hidden="true" />
      <p className="mt-3 text-sm font-medium text-[var(--sage-700)]">Your first hire starts here 🎂</p>
      <p className="mt-1 text-xs leading-5 text-[var(--cocoa-600)]">Move your best candidate here when you are ready.</p>
    </div>
  );
}

export function CandidateBoard({
  candidates,
  stageVisibility,
  debugMode = false,
  onAdvance,
  onStatusChange,
  onRemove,
  onUpload,
}: CandidateBoardProps) {
  const visibleStatuses = new Set<CandidateStatus>([
    ...(stageVisibility.new ? (['pending', 'new'] as CandidateStatus[]) : []),
    ...(stageVisibility.invited ? (['invited'] as CandidateStatus[]) : []),
    ...(stageVisibility.interviewed ? (['interviewed'] as CandidateStatus[]) : []),
    'hired',
  ]);

  const candidatesForLane = (lane: Lane) => candidates
    .filter(candidate => lane.statuses.includes(candidate.status) && visibleStatuses.has(candidate.status))
    .sort((left, right) => right.data.score.total - left.data.score.total);

  const handleLaneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches('[data-candidate-card]')) return;
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-candidate-card]'));
    const currentIndex = cards.indexOf(target);
    if (currentIndex < 0) return;
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    cards[(currentIndex + direction + cards.length) % cards.length]?.focus();
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3" aria-label="Candidate hiring pipeline">
      {LANES.map(lane => {
        const laneCandidates = candidatesForLane(lane);
        const isHired = lane.key === 'hired';
        return (
          <section
            key={lane.key}
            aria-labelledby={`lane-${lane.key}`}
            className={`min-w-0 rounded-[var(--radius-lg)] border border-[var(--cocoa-100)] border-l-4 ${lane.border} p-4 ${isHired ? 'hired-confetti-pattern' : 'bg-[var(--cocoa-50)]'}`}
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 id={`lane-${lane.key}`} className={`font-display text-base font-semibold ${isHired ? 'text-[var(--sage-700)]' : 'text-[var(--cocoa-800)]'}`}>
                <span aria-hidden="true">{lane.emoji}</span> {lane.label}
              </h3>
              <span className="rounded-full border border-[var(--cocoa-200)] bg-white px-2.5 py-1 text-xs font-semibold text-[var(--cocoa-700)]">
                {laneCandidates.length}
              </span>
            </div>

            <div className="space-y-4" onKeyDown={handleLaneKeyDown}>
              {laneCandidates.length > 0 ? laneCandidates.map((candidate, index) => (
                <CandidateCard
                  key={candidate.id}
                  candidateId={candidate.id}
                  data={candidate.data}
                  status={candidate.status}
                  index={index}
                  debugMode={debugMode}
                  onAdvance={onAdvance}
                  onStatusChange={onStatusChange}
                  onRemove={onRemove}
                />
              )) : (
                <EmptyLane lane={lane} hasCandidates={candidates.length > 0} onUpload={onUpload} />
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
