'use client';

import { useState } from 'react';
import { RecruiterSemanticSearch } from '@/components/demo/recruiter-semantic-search';
import { CriteriaWorkbench } from '@/components/search/criteria-workbench';
import type { ManagerCriteriaEvaluation } from '@/lib/contracts/manager-criteria';
import { getRoleById } from '@/lib/domain/roles';

export function SmartSearchTab({ debugMode = false, roleId = 'barista', candidateRefs = [], sample = true, evaluation, onEvaluation, onClear }: {
  debugMode?: boolean;
  roleId?: string;
  candidateRefs?: string[];
  sample?: boolean;
  evaluation?: ManagerCriteriaEvaluation;
  onEvaluation: (evaluation: ManagerCriteriaEvaluation) => void;
  onClear: () => void;
}) {
  const roleTitle = getRoleById(roleId)?.title ?? roleId;
  const [view, setView] = useState<'evidence' | 'criteria'>(sample && !evaluation ? 'evidence' : 'criteria');
  const [criteriaRequest, setCriteriaRequest] = useState('');
  return (
    <section aria-labelledby="smart-search-tab-title">
      <div className="mb-6">
        <p className="cocoa-label">Evidence-led discovery</p>
        <h2 id="smart-search-tab-title" className="mt-2 font-display text-3xl font-semibold text-[var(--cocoa-900)]">Smart Search</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--cocoa-600)]">
          Find supporting evidence, or turn your requirements into criteria you approve. Covers {roleTitle} · {candidateRefs.length} visible {sample ? 'fictional profiles' : 'applicants'} and respects the board filters.
        </p>
      </div>
      {sample ? <div className="mb-5 inline-flex max-w-full flex-wrap gap-1 rounded-full border border-[var(--cocoa-200)] bg-white p-1" aria-label="Smart Search view">
        {(['evidence', 'criteria'] as const).map(option => <button key={option} type="button" aria-pressed={view === option} onClick={() => setView(option)} className={`min-h-10 rounded-full px-4 text-sm font-semibold transition ${view === option ? 'bg-[var(--cocoa-700)] text-white' : 'text-[var(--cocoa-600)] hover:bg-[var(--cocoa-50)]'}`}>{option === 'evidence' ? 'Find evidence' : 'Build criteria'}</button>)}
      </div> : null}
      {view === 'evidence' && sample ? (
        <RecruiterSemanticSearch
          key={JSON.stringify([roleId, candidateRefs.slice().sort()])}
          debugMode={debugMode}
          roleId={roleId}
          candidateRefs={candidateRefs}
          onCriteriaRequest={request => { setCriteriaRequest(request); setView('criteria'); }}
        />
      ) : (
        <CriteriaWorkbench
          key={JSON.stringify([roleId, candidateRefs.slice().sort()])}
          roleId={roleId}
          roleTitle={roleTitle}
          candidateIds={candidateRefs}
          sample={sample}
          initialRequest={criteriaRequest}
          evaluation={evaluation}
          onEvaluation={onEvaluation}
          onClear={onClear}
        />
      )}
    </section>
  );
}
