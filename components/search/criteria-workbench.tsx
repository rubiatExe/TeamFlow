'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, ClipboardCheck, LoaderCircle, Sparkles, X } from 'lucide-react';
import {
  ManagerCriteriaEvaluationSchema,
  ManagerCriteriaProposalSchema,
  ManagerCriteriaSchema,
  type ManagerCriteriaEvaluation,
  type ManagerCriteriaProposal,
  type ManagerCriterion,
} from '@/lib/contracts/manager-criteria';
import { CriterionAssessment } from './criterion-assessment';
import { evaluationMatchesApproval } from '@/lib/domain/criteria-presentation';

type Props = {
  roleId: string;
  roleTitle: string;
  candidateIds: string[];
  sample: boolean;
  initialRequest?: string;
  evaluation?: ManagerCriteriaEvaluation;
  onEvaluation: (evaluation: ManagerCriteriaEvaluation) => void;
  onClear: () => void;
};

const FIELD_CLASS = 'min-h-11 w-full rounded-lg border border-[var(--cocoa-200)] bg-white px-3 py-2 text-sm text-[var(--cocoa-900)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cocoa-500)]';

export function CriteriaWorkbench({ roleId, roleTitle, candidateIds, sample, initialRequest = '', evaluation, onEvaluation, onClear }: Props) {
  const [request, setRequest] = useState(initialRequest);
  const [proposal, setProposal] = useState<ManagerCriteriaProposal | null>(null);
  const [criteria, setCriteria] = useState<ManagerCriterion[]>([]);
  const [weight, setWeight] = useState(20);
  const [loading, setLoading] = useState<'propose' | 'approve' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const proposalHeadingRef = useRef<HTMLHeadingElement>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const requestInputRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const scopeKey = JSON.stringify(candidateIds.slice().sort());
  const proposalScopeMatches = proposal && proposal.role_id === roleId
    && JSON.stringify(proposal.candidate_ids.slice().sort()) === scopeKey;
  const validCriteria = ManagerCriteriaSchema.safeParse(criteria).success;
  const weightTotal = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  const visibleResults = evaluation?.results.filter(result => candidateIds.includes(result.candidate_id)) ?? [];

  useEffect(() => () => controllerRef.current?.abort(), []);

  const submitRequest = async (action: 'propose' | 'approve') => {
    if (loading || (action === 'approve' && (!proposal || !proposalScopeMatches || !validCriteria))) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(action);
    setError(null);
    setNotice(null);
    if (action === 'propose') setProposal(null);
    try {
      const response = await fetch('/api/manager-criteria', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify(action === 'propose' ? {
          action, mode: sample ? 'sample' : 'connected', role_id: roleId,
          candidate_ids: candidateIds, manager_request: request.trim(),
        } : {
          action, approval_token: proposal!.approval_token, criteria,
          additional_weight_percent: weight,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!response.ok) {
        const publicError = payload && typeof payload === 'object' && 'error' in payload ? payload.error : null;
        setError(typeof publicError === 'string' ? publicError : 'Criteria could not be processed. Please try again.');
        return;
      }
      if (action === 'propose') {
        const parsed = ManagerCriteriaProposalSchema.safeParse(payload);
        if (!parsed.success) throw new Error('invalid_response');
        if (parsed.data.role_id !== roleId || parsed.data.mode !== (sample ? 'sample' : 'connected')
          || JSON.stringify(parsed.data.candidate_ids.slice().sort()) !== scopeKey) throw new Error('scope_mismatch');
        setProposal(parsed.data);
        setCriteria(parsed.data.criteria);
        setWeight(20);
        requestAnimationFrame(() => proposalHeadingRef.current?.focus());
      } else {
        const parsed = ManagerCriteriaEvaluationSchema.safeParse(payload);
        if (!parsed.success) throw new Error('invalid_response');
        if (!proposal || !evaluationMatchesApproval(parsed.data, proposal, criteria, weight)) throw new Error('approval_mismatch');
        onEvaluation(parsed.data);
        setProposal(null);
        setNotice(`Criteria approved. ${parsed.data.results.length} profiles reassessed for this page visit; base scores are unchanged.`);
        requestAnimationFrame(() => resultsHeadingRef.current?.focus());
      }
    } catch {
      if (!controller.signal.aborted) setError('The criteria service could not return a verified response. Existing scores are unchanged.');
    } finally {
      if (!controller.signal.aborted) setLoading(null);
    }
  };

  const propose = (event: FormEvent) => { event.preventDefault(); void submitRequest('propose'); };

  return (
    <div className="space-y-5">
      <form onSubmit={propose} className="rounded-[var(--radius-lg)] border border-[var(--cocoa-100)] bg-white p-5 shadow-[var(--shadow-card)] sm:p-6">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-[var(--cocoa-100)] p-2.5 text-[var(--cocoa-700)]"><Sparkles className="size-5" aria-hidden="true" /></span>
          <div><h3 className="font-display text-xl font-semibold text-[var(--cocoa-900)]">What else matters for this role?</h3><p className="mt-1 text-xs leading-5 text-[var(--cocoa-600)]">Describe job-related requirements. Review the proposed criteria before any score changes.</p></div>
        </div>
        <label htmlFor={`${id}-request`} className="mt-5 block text-xs font-semibold text-[var(--cocoa-700)]">Your request for {roleTitle}</label>
        <textarea ref={requestInputRef} id={`${id}-request`} value={request} onChange={event => setRequest(event.target.value)} maxLength={500} rows={3} required disabled={Boolean(loading)} placeholder="e.g. I need someone with latte art experience and weekend availability" className={`${FIELD_CLASS} mt-2 resize-y`} aria-describedby={`${id}-privacy`} />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-[var(--cocoa-600)]">{candidateIds.length} visible {sample ? 'fictional profiles' : 'applicants'} · {sample ? 'Sample rules' : 'Agent 1 · cited evidence'}</p>
          <button type="submit" disabled={Boolean(loading) || request.trim().length < 3 || candidateIds.length === 0 || candidateIds.length > 20} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[var(--cocoa-700)] px-5 text-sm font-semibold text-white transition hover:bg-[var(--cocoa-600)] disabled:opacity-50">
            {loading === 'propose' ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Sparkles className="size-4" aria-hidden="true" />}
            {loading === 'propose' ? 'Drafting criteria…' : 'Propose criteria'}
          </button>
        </div>
        <p id={`${id}-privacy`} className="mt-3 text-[11px] leading-5 text-[var(--cocoa-500)]">{sample ? 'Fictional sample mode uses built-in matching rules, not a live agent.' : 'The connected agent uses approved résumé sources. Requests and source evidence may be processed by Google.'} Use skills and work requirements, not personal or protected traits. Up to 20 profiles per assessment.</p>
      </form>

      {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-800">{error}</p> : null}
      {notice ? <p role="status" className="rounded-xl border border-[var(--sage-100)] bg-[var(--sage-50)] p-4 text-sm leading-6 text-[var(--sage-700)]">{notice}</p> : null}

      {proposal ? (
        <section aria-labelledby={`${id}-review-title`} className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--cocoa-300)] bg-white shadow-[var(--shadow-card)]">
          <div className="border-b border-[var(--cocoa-100)] bg-[var(--cream-50)] p-5 sm:p-6">
            <p className="cocoa-label">Your approval is needed</p>
            <h3 id={`${id}-review-title`} ref={proposalHeadingRef} tabIndex={-1} className="mt-1 font-display text-2xl font-semibold text-[var(--cocoa-900)]">Do these criteria look right?</h3>
            <p className="mt-2 text-sm leading-6 text-[var(--cocoa-600)] [overflow-wrap:anywhere]">“{proposal.manager_request}”</p>
            <p className="mt-2 text-xs leading-5 text-[var(--cocoa-600)]">No scores have changed. Review the wording and adjust the weights. To change the criteria, refine your request and propose again. Approval applies the same criteria to all {proposal.candidate_ids.length} profiles in this scope.</p>
          </div>
          <div className="space-y-5 p-5 sm:p-6">
            <ol className="space-y-3">
              {criteria.map((criterion, index) => (
                <li key={criterion.criterion_id} className="flex items-start gap-3">
                  <span className="mt-7 flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--cocoa-100)] text-xs font-bold text-[var(--cocoa-600)]">{index + 1}</span>
                  <div className="min-w-0 flex-1"><label htmlFor={`${id}-criterion-${index}`} className="text-[11px] font-semibold text-[var(--cocoa-600)]">Criterion</label><textarea id={`${id}-criterion-${index}`} value={criterion.criterion_text} readOnly rows={2} className={`${FIELD_CLASS} mt-1 resize-y`} /></div>
                  <div className="w-16 shrink-0"><label htmlFor={`${id}-weight-${index}`} className="text-[11px] font-semibold text-[var(--cocoa-600)]">Weight</label><input id={`${id}-weight-${index}`} type="number" min={1} max={100} value={criterion.weight} disabled={Boolean(loading)} onChange={event => setCriteria(previous => previous.map((item, itemIndex) => itemIndex === index ? { ...item, weight: Number(event.target.value) } : item))} className={`${FIELD_CLASS} mt-1 px-2 tabular-nums`} /><span className="mt-1 block text-center text-[10px] text-[var(--cocoa-500)]">of 100</span></div>
                </li>
              ))}
            </ol>
            <p className={`text-right text-xs font-semibold ${weightTotal === 100 ? 'text-[var(--sage-700)]' : 'text-red-700'}`} aria-live="polite">Weights: {weightTotal}/100{weightTotal !== 100 ? ' — must total 100' : ''}</p>
            <div className="rounded-xl bg-[var(--cocoa-50)] p-4">
              <label htmlFor={`${id}-blend`} className="block text-sm font-semibold text-[var(--cocoa-800)]">How much should these criteria count?</label>
              <input id={`${id}-blend`} type="range" min={1} max={50} step={1} value={weight} disabled={Boolean(loading)} onChange={event => setWeight(Number(event.target.value))} className="mt-3 min-h-8 w-full accent-[var(--cocoa-700)]" />
              <div className="flex justify-between gap-3 text-xs font-semibold text-[var(--cocoa-700)]"><span>Base score {100 - weight}%</span><span>Added criteria {weight}%</span></div>
              <p className="mt-3 text-xs leading-5 text-[var(--cocoa-600)]">Updated score = base × {(100 - weight) / 100} + added-criteria score × {weight / 100}. Both scores remain visible. Missing evidence stays provisional; no automatic hiring decisions.</p>
            </div>
            {proposal.warnings.map(warning => <p key={warning} className="text-xs leading-5 text-[var(--cocoa-600)]">{warning}</p>)}
            {!proposalScopeMatches ? <p role="alert" className="text-sm text-amber-800">The visible profiles changed. Propose criteria again before approving.</p> : null}
            <p className="text-xs leading-5 text-[var(--cocoa-600)]">{evaluation ? 'This replaces the previous added-criteria assessment for this role. ' : ''}Results stay for this page visit and do not overwrite saved, human-reviewed base scores.</p>
            <div className="flex flex-wrap gap-2 border-t border-[var(--cocoa-100)] pt-4">
              <button type="button" onClick={() => void submitRequest('approve')} disabled={Boolean(loading) || !validCriteria || !proposalScopeMatches} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[var(--sage-700)] px-5 text-sm font-semibold text-white transition hover:bg-[var(--sage-600)] disabled:opacity-50">{loading === 'approve' ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Check className="size-4" aria-hidden="true" />}{loading === 'approve' ? 'Evaluating evidence…' : 'Approve & reassess'}</button>
              <button type="button" disabled={Boolean(loading)} onClick={() => { setProposal(null); setNotice('Proposal declined. Existing scores are unchanged.'); requestAnimationFrame(() => requestInputRef.current?.focus()); }} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--cocoa-200)] px-4 text-sm font-semibold text-[var(--cocoa-700)] hover:bg-[var(--cocoa-50)] disabled:opacity-50"><X className="size-4" aria-hidden="true" />Not quite</button>
            </div>
          </div>
        </section>
      ) : null}

      {evaluation ? (
        <section aria-labelledby={`${id}-results-title`} className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h3 id={`${id}-results-title`} ref={resultsHeadingRef} tabIndex={-1} className="flex items-center gap-2 font-display text-xl font-semibold text-[var(--cocoa-900)]"><ClipboardCheck className="size-5" aria-hidden="true" />Approved criteria · comparison</h3><p className="mt-1 text-xs leading-5 text-[var(--cocoa-600)]">{visibleResults.length} visible of {evaluation.results.length} assessed profiles · {evaluation.mode === 'sample' ? 'Fictional sample' : 'Session assessment'} · Base scores unchanged</p><p className="mt-1 text-xs leading-5 text-[var(--cocoa-600)]">Evidence snapshot at approval. Reassess after résumé or application updates.</p></div>
            <button type="button" disabled={Boolean(loading)} onClick={onClear} className="min-h-10 rounded-full border border-[var(--cocoa-200)] px-4 text-xs font-semibold text-[var(--cocoa-700)] hover:bg-white disabled:opacity-50">Clear added assessment</button>
          </div>
          <div className="grid items-start gap-3 lg:grid-cols-2">{visibleResults.map(result => <CriterionAssessment key={result.candidate_id} assessment={result} sample={evaluation.mode === 'sample'} showName />)}</div>
          {visibleResults.length === 0 ? <p className="text-sm text-[var(--cocoa-600)]">None of the assessed profiles match the current board filters.</p> : null}
          {evaluation.warnings.map(warning => <p key={warning} className="text-xs leading-5 text-[var(--cocoa-600)]">{warning}</p>)}
        </section>
      ) : null}
    </div>
  );
}
