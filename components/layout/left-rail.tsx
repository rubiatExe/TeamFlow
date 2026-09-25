'use client';

import { RotateCcw, SlidersHorizontal } from 'lucide-react';

import type { StageVisibility } from '@/components/candidates/candidate-board';
import { CAFE_ROLES, getRoleOrDefault } from '@/lib/domain/roles';
import type { HiringPersona } from '@/lib/domain/demo-workspace';

interface LeftRailProps {
  selectedRoleId: string;
  personas?: Record<string, HiringPersona>;
  showScoreFilter?: boolean;
  candidateCounts: Record<string, number>;
  stageVisibility: StageVisibility;
  minScore: number;
  onRoleSelect: (roleId: string) => void;
  onStageVisibilityChange: (stage: keyof StageVisibility, visible: boolean) => void;
  onMinScoreChange: (score: number) => void;
  onOpenHiringSettings?: () => void;
  mobile?: boolean;
}

export function LeftRail({
  selectedRoleId,
  personas,
  showScoreFilter = true,
  candidateCounts,
  stageVisibility,
  minScore,
  onRoleSelect,
  onStageVisibilityChange,
  onMinScoreChange,
  onOpenHiringSettings,
  mobile = false,
}: LeftRailProps) {
  const selectedRole = getRoleOrDefault(selectedRoleId);
  const selectedPersona = personas?.[selectedRoleId];
  const filtersActive = (showScoreFilter && minScore > 0) || Object.values(stageVisibility).some(value => !value);

  const clearFilters = () => {
    onMinScoreChange(0);
    onStageVisibilityChange('new', true);
    onStageVisibilityChange('invited', true);
    onStageVisibilityChange('interviewed', true);
  };

  return (
    <aside className={mobile ? 'bg-[var(--cream-50)] pb-6' : 'sticky top-20 hidden max-h-[calc(100dvh-5rem)] w-[280px] shrink-0 self-start overflow-y-auto border-r border-[var(--cocoa-100)] bg-[var(--cream-50)] px-5 py-6 md:block'} aria-label="Hiring roles and filters">
      <section>
        <p className="cocoa-label">Hiring for</p>
        <div className="mt-3 space-y-2">
          {CAFE_ROLES.map(role => {
            const selected = role.id === selectedRoleId;
            return (
              <button
                key={role.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onRoleSelect(role.id)}
                className={`relative flex min-h-[62px] w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-left transition-all duration-150 ${
                  selected
                    ? 'border-2 border-[var(--cocoa-600)] border-l-4 border-l-[var(--cocoa-700)] bg-[var(--cocoa-100)]'
                    : 'border border-[var(--cocoa-100)] bg-[var(--cocoa-50)] hover:bg-[var(--cocoa-100)]'
                }`}
              >
                <span className="text-xl" aria-hidden="true">{role.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[var(--cocoa-800)]">{role.title}</span>
                  <span className="mt-0.5 block text-xs text-[var(--cocoa-600)]">${personas?.[role.id]?.wageMin ?? role.wageRange.min}–${personas?.[role.id]?.wageMax ?? role.wageRange.max}/hr</span>
                </span>
                <span className="rounded-full bg-[var(--cocoa-200)] px-2 py-0.5 text-[11px] font-semibold text-[var(--cocoa-800)]" aria-label={`${candidateCounts[role.id] ?? 0} applicants`}>
                  {candidateCounts[role.id] ?? 0}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="mt-7 border-t border-[var(--cocoa-100)] pt-6">
        <div className="flex items-center justify-between gap-2">
          <p className="cocoa-label">Filters</p>
          <SlidersHorizontal className="size-4 text-[var(--cocoa-500)]" aria-hidden="true" />
        </div>
        <fieldset className="mt-4">
          <legend className="text-xs font-semibold text-[var(--cocoa-700)]">Pipeline stage</legend>
          <div className="mt-2 space-y-2.5">
            {([
              ['new', 'New & pending'],
              ['invited', 'Invited'],
              ['interviewed', 'Interviewed'],
            ] as const).map(([stage, label]) => (
              <label key={stage} className="flex min-h-8 cursor-pointer items-center gap-2.5 text-sm text-[var(--cocoa-700)]">
                <input
                  type="checkbox"
                  checked={stageVisibility[stage]}
                  onChange={event => onStageVisibilityChange(stage, event.target.checked)}
                  className="size-4 accent-[var(--cocoa-700)]"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        {showScoreFilter ? <div className="mt-5">
          <label htmlFor={mobile ? 'minimum-score-mobile' : 'minimum-score'} className="text-xs font-semibold text-[var(--cocoa-700)]">Min score: <span className="tabular-nums">{minScore}</span></label>
          <input
            id={mobile ? 'minimum-score-mobile' : 'minimum-score'}
            type="range"
            min="0"
            max="100"
            step="5"
            value={minScore}
            onChange={event => onMinScoreChange(Number(event.target.value))}
            className="mt-3 h-2 w-full cursor-pointer appearance-none rounded-full accent-[var(--cocoa-600)]"
            style={{ background: `linear-gradient(to right, var(--cocoa-600) 0%, var(--cocoa-600) ${minScore}%, var(--cocoa-200) ${minScore}%, var(--cocoa-200) 100%)` }}
          />
        </div> : null}

        {filtersActive ? (
          <button type="button" onClick={clearFilters} className="mt-4 inline-flex min-h-9 items-center gap-1.5 rounded-lg text-xs font-semibold text-[var(--cocoa-600)] hover:underline">
            <RotateCcw className="size-3.5" aria-hidden="true" /> Clear filters
          </button>
        ) : null}
      </section>

      <section className="mt-7 border-t border-[var(--cocoa-100)] pt-6">
        <p className="cocoa-label">Dealbreakers</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(selectedPersona?.dealbreakers ?? selectedRole.dealbreakers).map(dealbreaker => (
            <span key={dealbreaker} title="Demo review criterion; not an automatic gate" className="rounded-[var(--radius-sm)] bg-red-50 px-2.5 py-1.5 text-xs leading-5 text-red-800">
              ⚠️ {dealbreaker}
            </span>
          ))}
        </div>
        {selectedPersona?.dealbreakers.length === 0 ? <p className="mt-2 text-xs text-[var(--cocoa-600)]">No demo dealbreakers selected.</p> : null}
        {selectedPersona ? <p className="mt-3 text-xs leading-5 text-[var(--cocoa-600)]">Demo review criteria only. Changes do not rescore applicants or block actions.</p> : null}
      </section>

      {onOpenHiringSettings ? (
        <button type="button" onClick={onOpenHiringSettings} className="mt-6 min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--cocoa-300)] bg-white px-4 text-sm font-semibold text-[var(--cocoa-700)] hover:bg-[var(--cocoa-100)]">
          Edit hiring settings
        </button>
      ) : null}
    </aside>
  );
}
