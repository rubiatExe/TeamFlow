import { Check, ChevronDown, CircleHelp, ClipboardCheck, ClipboardList } from 'lucide-react';

import type { ApplicationCompleteness, ApplicationCompletionState } from '@/lib/contracts/application-completeness';
import { unknownApplicationCompleteness } from '@/lib/domain/application-completeness';

const LABELS: Record<ApplicationCompletionState, string> = {
  complete: 'Application filled',
  submitted_incomplete: 'Application needs details',
  in_progress: 'Application in progress',
  not_submitted: 'Application not submitted',
  unknown: 'Application status unknown',
};

export function ApplicationStatus({ application, sample = false }: {
  application?: ApplicationCompleteness;
  sample?: boolean;
}) {
  const summary = application ?? unknownApplicationCompleteness(sample
    ? 'This is a sample profile, not a saved application.'
    : undefined);
  const Icon = summary.state === 'complete' ? ClipboardCheck : summary.state === 'unknown' ? CircleHelp : ClipboardList;

  return (
    <details className="group/application min-w-0 text-[11px] text-[var(--cocoa-600)]">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md py-1 outline-none transition-colors hover:text-[var(--cocoa-900)] focus-visible:ring-2 focus-visible:ring-[var(--cocoa-600)] [&::-webkit-details-marker]:hidden">
        <Icon size={13} aria-hidden="true" className={summary.state === 'complete' ? 'shrink-0 text-[var(--sage-700)]' : 'shrink-0'} />
        <span className="min-w-0">{LABELS[summary.state]}</span>
        {summary.completed_sections !== null && (
          <span className="shrink-0 tabular-nums text-[var(--cocoa-500)]">{summary.completed_sections}/{summary.total_sections}</span>
        )}
        <ChevronDown size={12} aria-hidden="true" className="ml-auto shrink-0 transition-transform group-open/application:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="mt-1 space-y-2 rounded-lg border border-[var(--cocoa-100)] bg-[var(--cream-50)] p-3 leading-relaxed">
        <p>{summary.explanation}</p>
        {summary.completed_sections !== null && (
          <ul className="space-y-1" aria-label="Application sections">
            {summary.sections.map(section => (
              <li key={section.id} className="flex items-center gap-2">
                {section.complete ? <Check size={12} aria-hidden="true" className="shrink-0 text-[var(--sage-700)]" /> : <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full border border-current opacity-50" />}
                <span>{section.label}</span>
                <span className="ml-auto text-[10px]">{section.complete ? 'Filled' : 'Missing details'}</span>
              </li>
            ))}
          </ul>
        )}
        {summary.missing_fields.length > 0 && <p className="break-words">Missing: {summary.missing_fields.join('; ')}.</p>}
        <p className="border-t border-[var(--cocoa-100)] pt-2 text-[10px]">Completeness does not add or remove score points.</p>
      </div>
    </details>
  );
}
