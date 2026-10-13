'use client';

import { ChevronDown, Quote } from 'lucide-react';
import type { ManagerCriteriaCandidateResult } from '@/lib/contracts/manager-criteria';

export function CriterionAssessment({ assessment, sample = false, showName = false }: {
  assessment: ManagerCriteriaCandidateResult;
  sample?: boolean;
  showName?: boolean;
}) {
  const { base_score: base, additional_score: additional, updated_score: updated, additional_weight_percent: weight } = assessment;
  return (
    <details className="group/assessment min-w-0 rounded-xl border border-[var(--sage-100)] bg-[var(--sage-50)] text-[var(--cocoa-800)]">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-xl p-3 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {showName ? <span className="block font-display text-lg font-semibold">{assessment.display_name}</span> : null}
          <span className="block text-xs font-semibold">{sample ? 'Sample updated score' : 'Updated score · session assessment'}</span>
          <span className="mt-0.5 block text-[10px] text-[var(--cocoa-600)]">{assessment.provisional ? 'Provisional · evidence gaps' : 'With approved criteria'} · View contributions</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-right">
            <span className="block text-xl font-bold tabular-nums text-[var(--sage-700)]">{updated ?? '—'}<span className="text-[10px] font-medium">{updated !== null ? '/100' : ''}</span></span>
            <span className="block text-[10px] text-[var(--cocoa-600)]">Base {base ?? 'pending'}</span>
          </span>
          <ChevronDown className="size-4 transition-transform group-open/assessment:rotate-180" aria-hidden="true" />
        </span>
      </summary>
      <div className="space-y-3 border-t border-[var(--sage-100)] p-3 text-xs [overflow-wrap:anywhere]">
        <p className="leading-5">Base score stays unchanged. Added criteria contribute {weight}% of the updated score; the base contributes {100 - weight}%.</p>
        <p className="rounded-lg bg-white/80 p-2 font-semibold tabular-nums">{base === null
          ? `Added-criteria score: ${additional}/100. Updated total awaits a reviewed base score for this applied role.`
          : `${base} × ${(100 - weight) / 100} + ${additional} × ${weight / 100} = ${updated}/100 (rounded)`}</p>
        <ul className="space-y-3" aria-label={`Added criterion contributions for ${assessment.display_name}`}>
          {assessment.criteria.map(criterion => (
            <li key={criterion.criterion_id} className="rounded-lg border border-[var(--cocoa-100)] bg-white p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold leading-5">{criterion.criterion_text}</p>
                <span className="shrink-0 font-semibold tabular-nums">{criterion.points}/{criterion.weight}</span>
              </div>
              <p className={`mt-1 text-[10px] font-semibold ${criterion.status === 'met' ? 'text-[var(--sage-700)]' : criterion.status === 'unknown' ? 'text-amber-800' : 'text-red-700'}`}>
                {criterion.status === 'met' ? 'Supported by evidence' : criterion.status === 'not_met' ? 'Not met · cited evidence' : 'Not yet evidenced · follow up'}
                {' · '}{Number((criterion.points * weight / 100).toFixed(2))} points toward the updated total
              </p>
              {criterion.evidence.map((citation, index) => (
                <figure key={`${citation.source_block_id}-${index}`} className="mt-2 border-l-2 border-[var(--cocoa-200)] pl-2">
                  <blockquote className="leading-5">“{citation.exact_quote}”</blockquote>
                  <figcaption className="mt-1 flex items-start gap-1 text-[10px] text-[var(--cocoa-500)]"><Quote className="size-3 shrink-0" aria-hidden="true" /> Source {citation.source_block_id}</figcaption>
                </figure>
              ))}
            </li>
          ))}
        </ul>
        <p className="leading-5 text-[var(--cocoa-600)]">Unknown criteria earn no evidenced points yet; they do not mean the candidate lacks the skill. Application completeness is shown separately and adds no automatic bonus or penalty.</p>
      </div>
    </details>
  );
}
