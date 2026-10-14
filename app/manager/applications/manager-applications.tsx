'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getRoleById } from '@/lib/domain/roles';
import type { ManagerSubmission, ManagerSubmissionPage } from '@/lib/db/production-manager-submissions';

type Merchant = { id: string; name: string; role: 'owner' | 'manager' };
type PageState = 'checking' | 'ready' | 'sign-in' | 'unauthorized' | 'unavailable';
type LinkState = { url: string; expiresAt: number };

let browserAuth: SupabaseClient | null = null;

function getBrowserAuth(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  try {
    browserAuth ??= createClient(url, anonKey);
    return browserAuth;
  } catch { return null; }
}

function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body
    && typeof body.error === 'string') return body.error;
  return fallback;
}

function parseMerchants(body: unknown): Merchant[] | null {
  if (!body || typeof body !== 'object' || !('merchants' in body)
    || !Array.isArray(body.merchants)) return null;
  return body.merchants.filter((value: unknown): value is Merchant =>
    Boolean(value && typeof value === 'object'
      && 'id' in value && typeof value.id === 'string'
      && 'name' in value && typeof value.name === 'string'
      && 'role' in value && (value.role === 'owner' || value.role === 'manager')));
}

function parsePage(body: unknown): ManagerSubmissionPage | null {
  if (!body || typeof body !== 'object' || !('submissions' in body)
    || !Array.isArray(body.submissions) || !('nextPage' in body)) return null;
  if (body.nextPage !== null && (!Number.isInteger(body.nextPage) || typeof body.nextPage !== 'number')) return null;
  const submissions = body.submissions as unknown[];
  if (!submissions.every(value => value && typeof value === 'object'
    && 'id' in value && typeof value.id === 'string'
    && 'name' in value && typeof value.name === 'string'
    && 'email' in value && typeof value.email === 'string'
    && 'answers' in value && Boolean(value.answers))) return null;
  return { submissions: submissions as ManagerSubmission[], nextPage: body.nextPage as number | null };
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function displayList(values: string[]): string {
  return values.length ? values.join(', ') : 'Not provided';
}

function displayValue(value: string | boolean | undefined): string {
  if (value === undefined || value === '') return 'Not provided';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return value;
}

function AnswerRow({ label, value }: { label: string; value: string | boolean | undefined }) {
  return (
    <div>
      <dt className="text-sm font-medium text-[var(--cocoa-600)]">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap text-sm text-[var(--cocoa-900)]">{displayValue(value)}</dd>
    </div>
  );
}

export function ManagerApplications() {
  const [state, setState] = useState<PageState>('checking');
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [merchantId, setMerchantId] = useState('');
  const [submissions, setSubmissions] = useState<ManagerSubmission[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [links, setLinks] = useState<Record<string, LinkState>>({});
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const selectedMerchantRef = useRef('');

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const auth = getBrowserAuth();
    if (!auth) return null;
    const { data, error: sessionError } = await auth.auth.getSession();
    return sessionError ? null : data.session?.access_token ?? null;
  }, []);

  const loadPage = useCallback(async (selectedMerchantId: string, page: number, signal?: AbortSignal) => {
    const accessToken = await getAccessToken();
    if (!accessToken) { setState('sign-in'); return; }
    if (selectedMerchantId !== selectedMerchantRef.current) return;
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ merchantId: selectedMerchantId, page: String(page) });
      const response = await fetch(`/api/application/manager-submissions?${query}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
        signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (signal?.aborted || selectedMerchantId !== selectedMerchantRef.current) return;
      if (response.status === 401) { setState('sign-in'); return; }
      if (response.status === 403) { setState('unauthorized'); return; }
      if (!response.ok) throw new Error(messageFrom(body, 'Applications could not be loaded.'));
      const parsed = parsePage(body);
      if (!parsed) throw new Error('The application list was invalid. Try again.');
      setSubmissions(previous => page === 0 ? parsed.submissions : [...previous, ...parsed.submissions]);
      setNextPage(parsed.nextPage);
    } catch (loadError) {
      if (!signal?.aborted && selectedMerchantId === selectedMerchantRef.current) {
        setError(loadError instanceof Error ? loadError.message : 'Applications could not be loaded.');
      }
    } finally {
      if (!signal?.aborted && selectedMerchantId === selectedMerchantRef.current) setLoading(false);
    }
  }, [getAccessToken]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const accessToken = await getAccessToken();
        if (controller.signal.aborted) return;
        if (!accessToken) { setState('sign-in'); return; }
        const response = await fetch('/api/application/manager-scope', {
          headers: { Authorization: `Bearer ${accessToken}` },
          cache: 'no-store',
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (response.status === 401) { setState('sign-in'); return; }
        if (!response.ok) throw new Error(messageFrom(body, 'Manager workspaces could not be loaded.'));
        const scoped = parseMerchants(body);
        if (!scoped) throw new Error('The manager workspace response was invalid.');
        if (scoped.length === 0) { setState('unauthorized'); return; }
        setMerchants(scoped);
        selectedMerchantRef.current = scoped[0].id;
        setMerchantId(scoped[0].id);
        setState('ready');
      } catch (scopeError) {
        if (!controller.signal.aborted) {
          setError(scopeError instanceof Error ? scopeError.message : 'Manager workspaces could not be loaded.');
          setState('unavailable');
        }
      }
    })();
    return () => controller.abort();
  }, [getAccessToken]);

  useEffect(() => {
    if (state !== 'ready' || !merchantId) return;
    const controller = new AbortController();
    selectedMerchantRef.current = merchantId;
    setSubmissions([]);
    setNextPage(null);
    setLinks({});
    void loadPage(merchantId, 0, controller.signal);
    return () => controller.abort();
  }, [merchantId, state, loadPage]);

  async function prepareResume(applicationId: string) {
    setPreparingId(applicationId);
    setError('');
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) { setState('sign-in'); return; }
      const query = new URLSearchParams({ merchantId, applicationId });
      const response = await fetch(`/api/application/manager-resume?${query}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 401) { setState('sign-in'); return; }
      if (!response.ok) throw new Error(messageFrom(body, 'Résumé link could not be created.'));
      if (!body || typeof body !== 'object' || !('url' in body) || typeof body.url !== 'string') {
        throw new Error('The résumé link response was invalid.');
      }
      const signedUrl = new URL(body.url);
      const expectedOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '').origin;
      if (signedUrl.origin !== expectedOrigin || (signedUrl.protocol !== 'https:' && process.env.NODE_ENV === 'production')) {
        throw new Error('The résumé link response was invalid.');
      }
      setLinks(previous => ({ ...previous, [applicationId]: {
        url: signedUrl.toString(), expiresAt: Date.now() + 55_000,
      } }));
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : 'Résumé link could not be created.');
    } finally { setPreparingId(null); }
  }

  return (
    <main className="mx-auto max-w-5xl px-5 py-12 sm:py-16">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-[var(--cocoa-600)]">TeamFlow manager</p>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-[var(--cocoa-900)] sm:text-4xl">Submitted applications</h1>
          <p className="mt-3 text-[var(--cocoa-700)]">Review candidates’ answers and open their private résumés.</p>
        </div>
        <a href="/manager/application-links" className="rounded-lg border border-[var(--cocoa-200)] bg-white px-4 py-2 text-sm font-semibold text-[var(--cocoa-800)]">Create application link</a>
      </div>

      {state === 'checking' && <p role="status">Checking your manager sign-in…</p>}
      {state === 'sign-in' && (
        <section className="rounded-xl border border-[var(--cocoa-200)] bg-white p-6">
          <h2 className="text-xl font-semibold">Manager sign-in required</h2>
          <p className="mt-2">Sign in on the application links page, then return here to review submissions.</p>
          <a className="mt-4 inline-block font-semibold underline" href="/manager/application-links">Go to manager sign-in</a>
        </section>
      )}
      {state === 'unauthorized' && <p role="alert">Your account has no active owner or manager access to this workspace.</p>}
      {state === 'unavailable' && <p role="alert">{error || 'The manager workspace is temporarily unavailable.'}</p>}

      {state === 'ready' && (
        <>
          <label className="mb-4 block text-sm font-semibold" htmlFor="review-workspace">Workspace</label>
          <select id="review-workspace" value={merchantId} onChange={event => {
            selectedMerchantRef.current = event.target.value;
            setMerchantId(event.target.value);
          }} className="mb-6 w-full max-w-sm rounded-lg border border-[var(--cocoa-200)] bg-white px-3 py-2.5">
            {merchants.map(merchant => <option key={merchant.id} value={merchant.id}>{merchant.name}</option>)}
          </select>
          {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
          {loading && submissions.length === 0 && <p role="status">Loading applications…</p>}
          {!loading && submissions.length === 0 && !error && <p className="rounded-xl border border-[var(--cocoa-200)] bg-white p-6">No applications have been submitted in this workspace yet.</p>}
          <div className="space-y-4">
            {submissions.map(submission => {
              const role = getRoleById(submission.roleId);
              const link = links[submission.id];
              return (
                <article key={submission.id} className="rounded-xl border border-[var(--cocoa-200)] bg-white p-5 shadow-[var(--shadow-card)] sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-xl font-semibold">{submission.name}</h2>
                      <p className="text-sm text-[var(--cocoa-600)]">{role?.title ?? submission.roleId} · Submitted {displayDate(submission.submittedAt)}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <button type="button" disabled={preparingId === submission.id} onClick={() => void prepareResume(submission.id)} className="rounded-lg bg-[var(--cocoa-700)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{preparingId === submission.id ? 'Preparing…' : 'Prepare résumé link'}</button>
                      {link && Date.now() < link.expiresAt && <a href={link.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="text-sm font-semibold underline">Open résumé</a>}
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                    <a href={`mailto:${submission.email}`} className="underline">{submission.email}</a>
                    <span>{submission.phone}</span>
                    {submission.city && <span>{submission.city}</span>}
                  </div>
                  <details className="mt-5 border-t border-[var(--cocoa-100)] pt-4">
                    <summary className="cursor-pointer font-semibold">View application answers</summary>
                    <div className="mt-5 grid gap-6 sm:grid-cols-2">
                      <section>
                        <h3 className="mb-3 text-lg font-semibold">Availability</h3>
                        <dl className="space-y-3">
                          <AnswerRow label="Preferred shifts" value={displayList(submission.answers.profile.preferred_shifts)} />
                          <AnswerRow label="Available days" value={displayList(submission.answers.profile.days_available)} />
                          <AnswerRow label="Start date" value={submission.answers.profile.start_date} />
                          <AnswerRow label="Transportation" value={submission.answers.profile.transportation} />
                          <AnswerRow label="Contact preference" value={submission.answers.profile.contact_preference} />
                        </dl>
                      </section>
                      <section>
                        <h3 className="mb-3 text-lg font-semibold">Experience and skills</h3>
                        <dl className="space-y-3">
                          <AnswerRow label="Years of experience" value={submission.answers.skills.years_experience} />
                          <AnswerRow label="Skills" value={displayList(submission.answers.skills.skills)} />
                          <AnswerRow label="Certifications" value={displayList(submission.answers.skills.certifications)} />
                          <AnswerRow label="Languages" value={displayList(submission.answers.skills.languages)} />
                        </dl>
                      </section>
                      <section>
                        <h3 className="mb-3 text-lg font-semibold">Role questions</h3>
                        <dl className="space-y-3">
                          {Object.entries(submission.answers.knockout_answers).map(([id, value]) => <AnswerRow key={id} label={role?.questions.knockout.find(question => question.id === id)?.question ?? id} value={value} />)}
                        </dl>
                      </section>
                      <section>
                        <h3 className="mb-3 text-lg font-semibold">Motivation</h3>
                        <dl className="space-y-3">
                          <AnswerRow label="Why work here" value={submission.answers.motivation.why_work_here} />
                          <AnswerRow label="Superpower" value={submission.answers.motivation.superpower} />
                          <AnswerRow label="Above and beyond" value={submission.answers.motivation.above_and_beyond} />
                          {Object.entries(submission.answers.motivation.skill_answers).map(([id, value]) => <AnswerRow key={id} label={role?.questions.skills.find(question => question.id === id)?.question ?? id} value={value} />)}
                        </dl>
                      </section>
                    </div>
                  </details>
                </article>
              );
            })}
          </div>
          {nextPage !== null && <button type="button" disabled={loading} onClick={() => void loadPage(merchantId, nextPage)} className="mt-6 rounded-lg border border-[var(--cocoa-200)] bg-white px-4 py-2 font-semibold disabled:opacity-50">{loading ? 'Loading…' : 'Load more applications'}</button>}
        </>
      )}
    </main>
  );
}
