'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Stage = 'checking' | 'email' | 'code' | 'ready' | 'blocked' | 'unconfigured';
type Merchant = { id: string; name: string; role: 'owner' | 'manager' };
type Role = { id: string; title: string; emoji: string };
type CreatedInvitation = { url: string; expiresAt: string };

let browserAuth: SupabaseClient | null = null;

function getBrowserAuth(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  try {
    browserAuth ??= createClient(url, anonKey);
    return browserAuth;
  } catch {
    return null;
  }
}

function responseError(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body
    && typeof body.error === 'string') return body.error;
  return fallback;
}

export function ManagerApplicationLinks({ roles }: { roles: Role[] }) {
  const [stage, setStage] = useState<Stage>('checking');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [merchantId, setMerchantId] = useState('');
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const [candidateName, setCandidateName] = useState('');
  const [created, setCreated] = useState<CreatedInvitation | null>(null);

  const loadScope = useCallback(async (accessToken: string) => {
    let response: Response;
    try {
      response = await fetch('/api/application/manager-scope', {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      });
    } catch {
      setStage('blocked');
      throw new Error('The manager workspace service could not be reached. Try again.');
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) {
        try {
          await getBrowserAuth()?.auth.signOut({ scope: 'local' });
        } catch {
          // The server has already rejected the access token.
        }
        setStage('email');
      } else {
        setStage('blocked');
      }
      throw new Error(responseError(body, 'Your manager workspaces could not be loaded.'));
    }
    if (!body || typeof body !== 'object' || !('merchants' in body)
      || !Array.isArray(body.merchants)) {
      setStage('blocked');
      throw new Error('The manager workspace response was invalid.');
    }
    const scoped = body.merchants.filter((value: unknown): value is Merchant =>
      Boolean(value && typeof value === 'object'
        && 'id' in value && typeof value.id === 'string'
        && 'name' in value && typeof value.name === 'string'
        && 'role' in value && (value.role === 'owner' || value.role === 'manager')));
    setMerchants(scoped);
    setMerchantId(scoped[0]?.id ?? '');
    setCreated(null);
    setStage(scoped.length > 0 ? 'ready' : 'blocked');
    if (scoped.length === 0) {
      throw new Error('Your account has no active owner or manager workspace. Ask an administrator to assign one.');
    }
  }, []);

  useEffect(() => {
    let active = true;
    const auth = getBrowserAuth();
    if (!auth) {
      setStage('unconfigured');
      return;
    }
    void (async () => {
      let reachedScope = false;
      try {
        const { data, error: sessionError } = await auth.auth.getSession();
        if (!active) return;
        if (sessionError) {
          setStage('email');
          setError('Your saved sign-in could not be restored. Enter your email to continue.');
          return;
        }
        if (!data.session) {
          setStage('email');
          return;
        }
        setEmail(data.session.user.email ?? '');
        reachedScope = true;
        await loadScope(data.session.access_token);
      } catch (scopeError) {
        if (!active) return;
        if (!reachedScope) setStage('email');
        setError(scopeError instanceof Error ? scopeError.message : 'Manager sign-in failed.');
      }
    })();
    return () => { active = false; };
  }, [loadScope]);

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    const auth = getBrowserAuth();
    if (!auth) return setStage('unconfigured');
    const normalizedEmail = email.trim().toLowerCase();
    setBusy(true);
    try {
      const { error: sendError } = await auth.auth.signInWithOtp({
        email: normalizedEmail,
        options: { shouldCreateUser: false },
      });
      if (sendError) throw sendError;
      setEmail(normalizedEmail);
      setCode('');
      setStage('code');
      setNotice('Check your email for the sign-in code.');
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'The sign-in code could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    const auth = getBrowserAuth();
    if (!auth) return setStage('unconfigured');
    setBusy(true);
    try {
      const { data, error: verifyError } = await auth.auth.verifyOtp({
        email,
        token: code.trim(),
        type: 'email',
      });
      if (verifyError || !data.session) {
        throw verifyError ?? new Error('The code could not be verified.');
      }
      await loadScope(data.session.access_token);
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : 'The code could not be verified.');
    } finally {
      setBusy(false);
    }
  }

  async function retryScope() {
    setError('');
    setBusy(true);
    try {
      const auth = getBrowserAuth();
      if (!auth) {
        setStage('unconfigured');
        throw new Error('Manager sign-in is not configured.');
      }
      const { data, error: sessionError } = await auth.auth.getSession();
      if (sessionError || !data.session) {
        setStage('email');
        throw new Error('Your sign-in expired. Enter your email to continue.');
      }
      await loadScope(data.session.access_token);
    } catch (scopeError) {
      setError(scopeError instanceof Error ? scopeError.message : 'Manager workspaces could not be loaded.');
    } finally {
      setBusy(false);
    }
  }

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    setCreated(null);
    const auth = getBrowserAuth();
    if (!auth) return setStage('unconfigured');
    if (!merchantId || !roleId) return setError('Choose a workspace and role.');
    setBusy(true);
    try {
      const { data, error: sessionError } = await auth.auth.getSession();
      if (sessionError || !data.session) {
        setStage('email');
        throw new Error('Your sign-in expired. Enter your email to continue.');
      }
      const response = await fetch('/api/application/invitations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${data.session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          merchantId,
          roleId,
          ...(candidateName.trim() ? { candidateName: candidateName.trim() } : {}),
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401) {
          try {
            await auth.auth.signOut({ scope: 'local' });
          } catch {
            // The server has already rejected the access token.
          }
          setStage('email');
        }
        throw new Error(responseError(body, 'Application link could not be created.'));
      }
      if (!body || typeof body !== 'object' || !('invitation' in body)
        || !body.invitation || typeof body.invitation !== 'object'
        || !('url' in body.invitation) || typeof body.invitation.url !== 'string'
        || !('expiresAt' in body.invitation) || typeof body.invitation.expiresAt !== 'string') {
        throw new Error('The application link response was invalid.');
      }
      setCreated({ url: body.invitation.url, expiresAt: body.invitation.expiresAt });
      setNotice('One-use application link created. Share it with the intended candidate.');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Application link could not be created.');
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!created) return;
    setError('');
    try {
      await navigator.clipboard.writeText(created.url);
      setNotice('Application link copied.');
    } catch {
      setError('Copy failed. Select and copy the link from the field below.');
    }
  }

  async function signOut() {
    const auth = getBrowserAuth();
    if (!auth) return setStage('unconfigured');
    setBusy(true);
    setError('');
    try {
      const { error: signOutError } = await auth.auth.signOut();
      if (signOutError) throw signOutError;
      setMerchants([]);
      setMerchantId('');
      setCreated(null);
      setCode('');
      setStage('email');
      setNotice('Signed out.');
    } catch (signOutError) {
      setError(signOutError instanceof Error ? signOutError.message : 'Sign-out failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-12 sm:py-16">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-[var(--cocoa-600)]">TeamFlow manager</p>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-[var(--cocoa-900)] sm:text-4xl">Candidate application links</h1>
          <p className="mt-3 max-w-xl text-[var(--cocoa-700)]">Create a one-use link for a candidate to upload a résumé and complete an editable application.</p>
        </div>
        {(stage === 'ready' || stage === 'blocked') && (
          <button type="button" onClick={() => void signOut()} disabled={busy} className="rounded-lg border border-[var(--cocoa-200)] bg-white px-4 py-2 text-sm font-semibold text-[var(--cocoa-800)] disabled:opacity-50">Sign out</button>
        )}
      </div>

      <section className="rounded-[var(--radius-lg)] border border-[var(--cocoa-100)] bg-white p-6 shadow-[var(--shadow-card)] sm:p-8">
        {stage === 'checking' && <p role="status">Checking your manager sign-in…</p>}
        {stage === 'unconfigured' && <p role="alert">Manager sign-in is not configured. Contact the workspace administrator.</p>}

        {stage === 'email' && (
          <form onSubmit={sendCode} className="space-y-5">
            <div>
              <h2 className="text-xl font-semibold">Sign in as a manager</h2>
              <p className="mt-1 text-sm text-[var(--cocoa-600)]">Use the email address assigned to your TeamFlow workspace.</p>
            </div>
            <label className="block text-sm font-semibold" htmlFor="manager-email">Email address</label>
            <input id="manager-email" type="email" autoComplete="email" required maxLength={320} value={email} onChange={event => setEmail(event.target.value)} className="w-full rounded-lg border border-[var(--cocoa-200)] px-3 py-2.5" />
            <button type="submit" disabled={busy} className="rounded-lg bg-[var(--cocoa-700)] px-5 py-2.5 font-semibold text-white disabled:opacity-50">{busy ? 'Sending…' : 'Send sign-in code'}</button>
          </form>
        )}

        {stage === 'code' && (
          <form onSubmit={verifyCode} className="space-y-5">
            <div>
              <h2 className="text-xl font-semibold">Enter your email code</h2>
              <p className="mt-1 text-sm text-[var(--cocoa-600)]">Sent to {email}. The code expires after a short time.</p>
            </div>
            <label className="block text-sm font-semibold" htmlFor="manager-code">Sign-in code</label>
            <input id="manager-code" type="text" inputMode="numeric" autoComplete="one-time-code" required maxLength={12} value={code} onChange={event => setCode(event.target.value)} className="w-full rounded-lg border border-[var(--cocoa-200)] px-3 py-2.5 tracking-[0.12em]" />
            <div className="flex flex-wrap gap-3">
              <button type="submit" disabled={busy} className="rounded-lg bg-[var(--cocoa-700)] px-5 py-2.5 font-semibold text-white disabled:opacity-50">{busy ? 'Verifying…' : 'Verify code'}</button>
              <button type="button" disabled={busy} onClick={() => { setStage('email'); setError(''); setNotice(''); }} className="rounded-lg border border-[var(--cocoa-200)] px-5 py-2.5 font-semibold">Change email</button>
            </div>
          </form>
        )}

        {stage === 'blocked' && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Workspace access unavailable</h2>
            <button type="button" onClick={() => void retryScope()} disabled={busy} className="rounded-lg border border-[var(--cocoa-200)] px-5 py-2.5 font-semibold disabled:opacity-50">{busy ? 'Checking…' : 'Try again'}</button>
          </div>
        )}

        {stage === 'ready' && (
          <form onSubmit={createInvitation} className="space-y-5">
            <h2 className="text-xl font-semibold">Create an application link</h2>
            <div>
              <label className="mb-2 block text-sm font-semibold" htmlFor="manager-merchant">Workspace</label>
              <select id="manager-merchant" required value={merchantId} onChange={event => { setMerchantId(event.target.value); setCreated(null); }} className="w-full rounded-lg border border-[var(--cocoa-200)] bg-white px-3 py-2.5">
                {merchants.map(merchant => <option key={merchant.id} value={merchant.id}>{merchant.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-2 block text-sm font-semibold" htmlFor="manager-role">Role</label>
              <select id="manager-role" required value={roleId} onChange={event => { setRoleId(event.target.value); setCreated(null); }} className="w-full rounded-lg border border-[var(--cocoa-200)] bg-white px-3 py-2.5">
                {roles.map(role => <option key={role.id} value={role.id}>{role.emoji} {role.title}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-2 block text-sm font-semibold" htmlFor="candidate-name">Candidate name <span className="font-normal text-[var(--cocoa-600)]">(optional)</span></label>
              <input id="candidate-name" type="text" maxLength={200} value={candidateName} onChange={event => { setCandidateName(event.target.value); setCreated(null); }} placeholder="Name to show on their application" className="w-full rounded-lg border border-[var(--cocoa-200)] px-3 py-2.5" />
            </div>
            <button type="submit" disabled={busy} className="rounded-lg bg-[var(--cocoa-700)] px-5 py-2.5 font-semibold text-white disabled:opacity-50">{busy ? 'Creating…' : 'Create link'}</button>
          </form>
        )}

        {error && <p role="alert" className="mt-5 rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        {notice && <p role="status" className="mt-5 rounded-lg bg-[var(--sage-50)] p-3 text-sm text-[var(--sage-700)]">{notice}</p>}

        {stage === 'ready' && created && (
          <div className="mt-7 space-y-3 border-t border-[var(--cocoa-100)] pt-6">
            <h3 className="font-semibold">One-use application link</h3>
            <p className="text-sm text-[var(--cocoa-600)]">Expires {new Date(created.expiresAt).toLocaleString()}.</p>
            <input aria-label="Application link" type="text" readOnly value={created.url} onFocus={event => event.currentTarget.select()} className="w-full rounded-lg border border-[var(--cocoa-200)] bg-[var(--cream-50)] px-3 py-2.5 text-sm" />
            <button type="button" onClick={() => void copyLink()} className="rounded-lg border border-[var(--cocoa-200)] px-4 py-2 text-sm font-semibold">Copy link</button>
          </div>
        )}
      </section>
      {(stage === 'ready' || stage === 'blocked') && (
        <p className="mt-6 text-sm text-[var(--cocoa-600)]"><a href="/manager/applications" className="font-semibold underline underline-offset-2">View candidate applications</a></p>
      )}
    </main>
  );
}
