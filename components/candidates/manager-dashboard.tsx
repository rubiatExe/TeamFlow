'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Check, Coffee, RotateCcw, Search, X } from 'lucide-react';

import { CandidateBoard, type StageVisibility } from '@/components/candidates/candidate-board';
import type { CandidateActionResult } from '@/components/candidates/candidate-card';
import type { ProcessedResume } from '@/components/candidates/drop-zone';
import { PersonaSettings, type HiringPersona } from '@/components/hiring-personas/persona-settings';
import { BottomNav } from '@/components/layout/bottom-nav';
import { LeftRail } from '@/components/layout/left-rail';
import { MainTabs, type DashboardTab } from '@/components/layout/main-tabs';
import { StatsBar, type DashboardStats } from '@/components/layout/stats-bar';
import { Topbar } from '@/components/layout/topbar';
import { SmartSearchTab } from '@/components/search/smart-search-tab';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { OnboardingBanner } from '@/components/ui/onboarding-banner';
import { useToast } from '@/components/ui/toast';
import { UploadTab } from '@/components/upload/upload-tab';
import type { CandidateStatus, CandidateWithStatus, InviteRequest } from '@/lib/contracts/candidate';
import { deleteCandidateFromSupabase, DEMO_MERCHANT_ID, loadCandidatesFromSupabase, type CandidateRow, updateCandidateStatus } from '@/lib/db/supabase';
import { createDemoCandidates, createDemoPersonas, DEMO_WORKSPACE_STORAGE_KEY, isDemoCandidateId, parseDemoWorkspace, personaForRole, restoreDemoCandidates, serializeDemoWorkspace } from '@/lib/domain/demo-workspace';
import { CAFE_ROLES, getRoleById, getRoleOrDefault } from '@/lib/domain/roles';

interface ManagerDashboardProps {
  interactiveDemoEnabled?: boolean;
}

type InviteResult =
  | { success: true; delivery: 'accepted' | 'simulated'; message: string }
  | { success: false; error: { message: string; retryable: boolean } };

function parseInviteResult(value: unknown): InviteResult | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  if (result.success === true && (result.delivery === 'accepted' || result.delivery === 'simulated') && typeof result.message === 'string') {
    return { success: true, delivery: result.delivery, message: result.message };
  }
  if (result.success !== false || !result.error || typeof result.error !== 'object') return null;
  const error = result.error as Record<string, unknown>;
  if (typeof error.message !== 'string' || typeof error.retryable !== 'boolean') return null;
  return { success: false, error: { message: error.message, retryable: error.retryable } };
}

function rowToCandidate(row: CandidateRow): CandidateWithStatus {
  const requestedRole = row.analysis?.applied_role || row.job_id || 'barista';
  const roleId = getRoleById(requestedRole)?.id ?? 'barista';
  return {
    id: row.id || `candidate_${crypto.randomUUID()}`,
    status: (row.status as CandidateStatus) || 'new',
    data: {
      candidate: {
        name: row.name,
        email: row.email,
        phone: row.phone,
        city: row.city,
        skills: row.analysis?.skills || [],
        experience_years: row.analysis?.experience_years,
        applied_role: roleId,
      },
      score: {
        total: row.fit_score || 0,
        breakdown: row.analysis?.breakdown || { constraints: 0, experience: 0, logistics: 0 },
        explanation: row.analysis?.explanation || row.summary || 'Awaiting manager review.',
      },
      red_flags: row.red_flags || [],
    },
  };
}

const CONFETTI = Array.from({ length: 20 }, (_, index) => ({
  left: `${(index * 37) % 100}%`,
  delay: `${(index % 7) * 80}ms`,
  color: ['#5E9B5E', '#D49B68', '#7A4520', '#EAC99A', '#6D28D9'][index % 5],
  drift: `${((index % 5) - 2) * 28}px`,
  spin: `${280 + (index % 4) * 90}deg`,
}));

export function ManagerDashboard({ interactiveDemoEnabled = false }: ManagerDashboardProps) {
  const { addToast } = useToast();
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const personaReturnFocusRef = useRef<HTMLElement | null>(null);
  const hiredReturnFocusRef = useRef<HTMLElement | null>(null);
  const [candidates, setCandidates] = useState<CandidateWithStatus[]>(createDemoCandidates);
  const [selectedRoleId, setSelectedRoleId] = useState('barista');
  const [activeTab, setActiveTab] = useState<DashboardTab>('candidates');
  const [personas, setPersonas] = useState<Record<string, HiringPersona>>(createDemoPersonas);
  const [showSettings, setShowSettings] = useState(false);
  const [showMobileTools, setShowMobileTools] = useState(false);
  const [showHiredModal, setShowHiredModal] = useState<string | null>(null);
  const [usingSampleData, setUsingSampleData] = useState(true);
  const [demoStorageReady, setDemoStorageReady] = useState(false);
  const [demoStorageAvailable, setDemoStorageAvailable] = useState(true);
  const [debugMode, setDebugMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [minScore, setMinScore] = useState(0);
  const [stageVisibility, setStageVisibility] = useState<StageVisibility>({ new: true, invited: true, interviewed: true });

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setDebugMode(new URLSearchParams(window.location.search).get('debug') === 'true');
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (interactiveDemoEnabled) return;
    const frame = requestAnimationFrame(() => {
      try {
        const saved = parseDemoWorkspace(window.localStorage.getItem(DEMO_WORKSPACE_STORAGE_KEY));
        setCandidates(restoreDemoCandidates(saved));
        setPersonas({ ...createDemoPersonas(), ...saved?.personas });
      } catch {
        setDemoStorageAvailable(false);
      }
      setDemoStorageReady(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [interactiveDemoEnabled]);

  useEffect(() => {
    if (interactiveDemoEnabled || !demoStorageReady || !demoStorageAvailable) return;
    try {
      window.localStorage.setItem(DEMO_WORKSPACE_STORAGE_KEY, serializeDemoWorkspace(candidates, personas));
    } catch {
      const frame = requestAnimationFrame(() => {
        setDemoStorageAvailable(false);
        addToast('Browser storage is unavailable. Demo changes last for this visit only.', 'warning');
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [addToast, candidates, demoStorageAvailable, demoStorageReady, interactiveDemoEnabled, personas]);

  useEffect(() => {
    if (!interactiveDemoEnabled) return;
    let cancelled = false;
    void loadCandidatesFromSupabase(DEMO_MERCHANT_ID).then(rows => {
      if (cancelled || !rows || rows.length === 0) return;
      setCandidates(rows.map(rowToCandidate));
      setUsingSampleData(false);
    });
    return () => { cancelled = true; };
  }, [interactiveDemoEnabled]);

  const roleCandidates = useMemo(() => candidates.filter(candidate => candidate.data.candidate.applied_role === selectedRoleId), [candidates, selectedRoleId]);
  const visibleCandidates = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase('en-US');
    return roleCandidates.filter(candidate => {
      if (!isDemoCandidateId(candidate.id) && candidate.data.score.total < minScore) return false;
      if (!query) return true;
      return candidate.data.candidate.name.toLocaleLowerCase('en-US').includes(query)
        || candidate.data.candidate.email?.toLocaleLowerCase('en-US').includes(query)
        || candidate.data.candidate.skills.some(skill => skill.toLocaleLowerCase('en-US').includes(query));
    });
  }, [minScore, roleCandidates, searchQuery]);

  const stageVisibleCandidates = useMemo(() => visibleCandidates
    .filter(candidate => (
      candidate.status === 'hired'
      || ((candidate.status === 'new' || candidate.status === 'pending') && stageVisibility.new)
      || (candidate.status === 'invited' && stageVisibility.invited)
      || (candidate.status === 'interviewed' && stageVisibility.interviewed)
    )), [stageVisibility, visibleCandidates]);
  const searchCandidateRefs = useMemo(() => stageVisibleCandidates
    .filter(candidate => isDemoCandidateId(candidate.id))
    .map(candidate => candidate.id), [stageVisibleCandidates]);
  const hasScoredCandidates = roleCandidates.some(candidate => !isDemoCandidateId(candidate.id));

  const candidateCounts = useMemo(() => Object.fromEntries(CAFE_ROLES.map(role => [
    role.id,
    candidates.filter(candidate => candidate.data.candidate.applied_role === role.id).length,
  ])), [candidates]);

  const stats = useMemo<DashboardStats>(() => {
    const byStatus = {
      pending: roleCandidates.filter(candidate => candidate.status === 'pending').length,
      new: roleCandidates.filter(candidate => candidate.status === 'new').length,
      invited: roleCandidates.filter(candidate => candidate.status === 'invited').length,
      interviewed: roleCandidates.filter(candidate => candidate.status === 'interviewed').length,
      hired: roleCandidates.filter(candidate => candidate.status === 'hired').length,
    };
    const total = roleCandidates.length;
    const scoredCandidates = roleCandidates.filter(candidate => !isDemoCandidateId(candidate.id));
    const avgScore = scoredCandidates.length ? Math.round(scoredCandidates.reduce((sum, candidate) => sum + candidate.data.score.total, 0) / scoredCandidates.length) : 0;
    const top = [...scoredCandidates].sort((left, right) => right.data.score.total - left.data.score.total)[0];
    return {
      total,
      avgScore,
      byStatus,
      topCandidate: top ? { name: top.data.candidate.name, score: top.data.score.total } : undefined,
    };
  }, [roleCandidates]);

  const commitStatus = useCallback((candidateId: string, nextStatus: CandidateStatus) => {
    setCandidates(previous => previous.map(candidate => candidate.id === candidateId ? { ...candidate, status: nextStatus } : candidate));
    if (nextStatus === 'hired') {
      hiredReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setShowHiredModal(candidateId);
    }
  }, []);

  const changeStatus = useCallback(async (candidateId: string, nextStatus: CandidateStatus): Promise<boolean> => {
    if (isDemoCandidateId(candidateId) || candidateId.startsWith('demo_') || candidateId.startsWith('local_')) {
      await new Promise(resolve => setTimeout(resolve, 240));
      commitStatus(candidateId, nextStatus);
      return true;
    }
    if (!interactiveDemoEnabled) return false;
    const updated = await updateCandidateStatus(candidateId, nextStatus);
    if (!updated) {
      addToast('The status could not be saved. Nothing changed.', 'error');
      return false;
    }
    commitStatus(candidateId, nextStatus);
    return true;
  }, [addToast, commitStatus, interactiveDemoEnabled]);

  const handleStatusChange = useCallback(async (candidateId: string, nextStatus: CandidateStatus) => {
    await changeStatus(candidateId, nextStatus);
  }, [changeStatus]);

  const handleAdvance = useCallback(async (candidateId: string, nextStatus: CandidateStatus): Promise<CandidateActionResult> => {
    const candidate = candidates.find(item => item.id === candidateId);
    if (!candidate) return { ok: false, message: 'Candidate could not be found.' };

    if (nextStatus !== 'invited' || isDemoCandidateId(candidateId) || candidateId.startsWith('demo_') || candidateId.startsWith('local_')) {
      const changed = await changeStatus(candidateId, nextStatus);
      if (changed && nextStatus === 'invited') addToast('Demo invitation simulated. No message was sent.', 'success');
      return changed ? { ok: true } : { ok: false, message: 'The status could not be saved.' };
    }

    if (!interactiveDemoEnabled) return { ok: false, message: 'Invitations are disabled in the public preview.' };
    if (!candidate.data.candidate.phone?.trim()) return { ok: false, message: 'Add a phone number before sending an interview invitation.' };
    const request: InviteRequest = {
      candidateId,
      candidateName: candidate.data.candidate.name,
      candidatePhone: candidate.data.candidate.phone,
      storeName: 'Cocoa Bakery',
    };
    try {
      const response = await fetch('/api/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const result = parseInviteResult(await response.json().catch(() => null));
      if (!response.ok || !result?.success) {
        return { ok: false, message: result && !result.success ? result.error.message : 'The invitation was not sent.' };
      }
      await new Promise(resolve => setTimeout(resolve, 260));
      commitStatus(candidateId, 'invited');
      return { ok: true };
    } catch {
      return { ok: false, message: 'The invitation service could not be reached.' };
    }
  }, [addToast, candidates, changeStatus, commitStatus, interactiveDemoEnabled]);

  const handleRemove = useCallback(async (candidateId: string) => {
    if (!isDemoCandidateId(candidateId) && !candidateId.startsWith('demo_') && !candidateId.startsWith('local_')) {
      if (!interactiveDemoEnabled || !(await deleteCandidateFromSupabase(candidateId))) {
        addToast('The candidate could not be removed.', 'error');
        return;
      }
    }
    setCandidates(previous => previous.filter(candidate => candidate.id !== candidateId));
  }, [addToast, interactiveDemoEnabled]);

  const handleFileProcessed = useCallback(({ result, candidateId }: ProcessedResume) => {
    const roleId = getRoleById(result.candidate.applied_role || '')?.id ?? selectedRoleId;
    const candidate: CandidateWithStatus = {
      id: candidateId ?? `local_${crypto.randomUUID()}`,
      status: candidateId ? 'new' : 'pending',
      data: { ...result, candidate: { ...result.candidate, applied_role: roleId } },
    };
    setCandidates(previous => [candidate, ...previous]);
    setUsingSampleData(false);
  }, [selectedRoleId]);

  const selectRole = (roleId: string) => {
    setSelectedRoleId(roleId);
    setSearchQuery('');
    setMinScore(0);
    setStageVisibility({ new: true, invited: true, interviewed: true });
  };

  const resetDemo = () => {
    setCandidates(createDemoCandidates());
    setPersonas(createDemoPersonas());
    setSearchQuery('');
    setMinScore(0);
    setStageVisibility({ new: true, invited: true, interviewed: true });
    addToast('Fictional applicants and demo settings restored.', 'success');
  };

  const currentRole = getRoleOrDefault(selectedRoleId);
  const currentPersona = personas[selectedRoleId] ?? personaForRole(selectedRoleId);
  const hiredCandidate = showHiredModal ? candidates.find(candidate => candidate.id === showHiredModal) : undefined;
  const candidateCountLabel = stageVisibleCandidates.length === roleCandidates.length ? `${roleCandidates.length} applicants` : `${stageVisibleCandidates.length} of ${roleCandidates.length} applicants`;

  return (
    <div className="min-h-screen bg-[var(--cocoa-50)] pb-20 md:pb-0">
      <Topbar
        selectedRoleId={selectedRoleId}
        personas={personas}
        publicDemo={!interactiveDemoEnabled}
        onRoleSelect={selectRole}
        onUpload={() => setActiveTab('upload')}
        onSettings={() => {
          personaReturnFocusRef.current = settingsTriggerRef.current;
          setShowSettings(true);
        }}
        settingsTriggerRef={settingsTriggerRef}
      />
      <StatsBar stats={stats} showScores={hasScoredCandidates} />

      <div className="mx-auto flex max-w-[1600px] items-start">
        <LeftRail
          selectedRoleId={selectedRoleId}
          personas={personas}
          showScoreFilter={hasScoredCandidates}
          candidateCounts={candidateCounts}
          stageVisibility={stageVisibility}
          minScore={minScore}
          onRoleSelect={selectRole}
          onStageVisibilityChange={(stage, visible) => setStageVisibility(previous => ({ ...previous, [stage]: visible }))}
          onMinScoreChange={setMinScore}
          onOpenHiringSettings={() => {
            personaReturnFocusRef.current = settingsTriggerRef.current;
            setShowSettings(true);
          }}
        />

        <main id="main-content" className="min-w-0 flex-1 px-4 pb-10 md:px-6 lg:px-8">
          <MainTabs activeTab={activeTab} candidateCount={stats.total} onTabChange={setActiveTab} />
          {usingSampleData ? (
            <aside className="mt-4 flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--cocoa-200)] bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between" aria-label="Demo workspace notice">
              <div className="text-xs leading-5 text-[var(--cocoa-700)]">
                <p className="font-semibold">Demo · fictional applicants</p>
                <p>Practice the hiring workflow. Invitations are simulated; no messages are sent.</p>
                <p>{!interactiveDemoEnabled && demoStorageAvailable ? 'Demo stages and settings stay in this browser.' : 'Demo changes last for this page visit only.'}</p>
              </div>
              <button type="button" onClick={resetDemo} className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-md)] border border-[var(--cocoa-300)] px-3 text-xs font-semibold text-[var(--cocoa-700)] hover:bg-[var(--cocoa-50)]"><RotateCcw className="size-3.5" aria-hidden="true" /> Reset demo</button>
            </aside>
          ) : null}
          {debugMode ? (
            <div className="mt-4 rounded-[var(--radius-md)] border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-900" role="note">
              Debug mode · {usingSampleData ? 'sample records' : 'connected records'} · mutating demo routes {interactiveDemoEnabled ? 'enabled locally' : 'closed'}
            </div>
          ) : null}

          <div key={`${activeTab}-${selectedRoleId}`} id={`dashboard-panel-${activeTab}`} role="tabpanel" aria-labelledby={`dashboard-tab-${activeTab}`} className="tab-panel-enter py-6">
            {activeTab === 'candidates' ? (
              <section aria-labelledby="candidates-title">
                {usingSampleData ? <OnboardingBanner sampleCount={stageVisibleCandidates.length} publicDemo={!interactiveDemoEnabled} onUpload={() => setActiveTab('upload')} onSearch={() => setActiveTab('search')} /> : null}
                <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="cocoa-label">{currentRole.emoji} {currentRole.title} pipeline</p>
                    <h2 id="candidates-title" className="mt-1 font-display text-3xl font-semibold text-[var(--cocoa-900)]">Candidates</h2>
                    <p className="mt-1 text-sm text-[var(--cocoa-600)]">{candidateCountLabel} · {usingSampleData ? 'fictional profiles, listed alphabetically' : 'sorted by fit score'}</p>
                  </div>
                  <div className="relative w-full sm:max-w-xs">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--cocoa-500)]" aria-hidden="true" />
                    <label htmlFor="candidate-search" className="sr-only">Search {currentRole.title} candidates</label>
                    <input id="candidate-search" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search name, email, or skill" className="min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--cocoa-200)] bg-white pl-10 pr-10 text-sm text-[var(--cocoa-800)] placeholder:text-[var(--cocoa-500)]" />
                    {searchQuery ? <button type="button" onClick={() => setSearchQuery('')} aria-label="Clear candidate search" className="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--cocoa-600)] hover:bg-[var(--cocoa-100)]"><X className="size-4" aria-hidden="true" /></button> : null}
                  </div>
                </div>
                <CandidateBoard
                  candidates={stageVisibleCandidates}
                  sampleMode={usingSampleData}
                  stageVisibility={stageVisibility}
                  debugMode={debugMode}
                  onAdvance={handleAdvance}
                  onStatusChange={handleStatusChange}
                  onRemove={handleRemove}
                  onUpload={interactiveDemoEnabled ? () => setActiveTab('upload') : undefined}
                />
              </section>
            ) : null}

            {activeTab === 'upload' ? (
              <UploadTab
                roleId={selectedRoleId}
                disabled={!interactiveDemoEnabled}
                onFileProcessed={handleFileProcessed}
                onViewCandidates={() => setActiveTab('candidates')}
                onSearch={() => setActiveTab('search')}
              />
            ) : null}

            {activeTab === 'search' ? usingSampleData ? (
              <SmartSearchTab debugMode={debugMode} roleId={selectedRoleId} candidateRefs={searchCandidateRefs} />
            ) : (
              <section aria-labelledby="connected-search-title" className="rounded-[var(--radius-lg)] border border-[var(--cocoa-200)] bg-white p-6">
                <h2 id="connected-search-title" className="font-display text-2xl text-[var(--cocoa-900)]">Smart Search is a fictional-profile demo</h2>
                <p className="mt-2 text-sm leading-6 text-[var(--cocoa-600)]">Your connected applicants are not part of the public search corpus. Use the name, email, and skill filter on Candidates to review this workspace.</p>
                <button type="button" onClick={() => setActiveTab('candidates')} className="mt-4 min-h-11 rounded-[var(--radius-md)] bg-[var(--cocoa-700)] px-4 text-sm font-semibold text-white">View Candidates</button>
              </section>
            ) : null}
          </div>
        </main>
      </div>

      <BottomNav
        activeTab={activeTab}
        settingsOpen={showMobileTools}
        onTabChange={tab => { setShowMobileTools(false); setActiveTab(tab); }}
        onSettings={() => setShowMobileTools(true)}
        settingsTriggerRef={mobileSettingsTriggerRef}
      />

      <Dialog open={showMobileTools} onOpenChange={setShowMobileTools}>
        <DialogContent
          className="bottom-0 left-0 top-auto max-h-[88dvh] w-full max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-b-none rounded-t-[var(--radius-xl)] border border-[var(--cocoa-200)] bg-[var(--cream-50)] p-5 shadow-[var(--shadow-modal)] md:hidden"
          onCloseAutoFocus={event => { event.preventDefault(); mobileSettingsTriggerRef.current?.focus(); }}
        >
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <DialogTitle className="font-display text-2xl text-[var(--cocoa-900)]">Workspace Settings</DialogTitle>
              <DialogDescription className="mt-1 text-[var(--cocoa-600)]">Choose a role and adjust the visible pipeline.</DialogDescription>
            </div>
            <DialogClose asChild><button type="button" aria-label="Close workspace settings" className="flex size-10 items-center justify-center rounded-full text-[var(--cocoa-600)] hover:bg-[var(--cocoa-100)]"><X className="size-5" aria-hidden="true" /></button></DialogClose>
          </div>
          <LeftRail
            mobile
            selectedRoleId={selectedRoleId}
            personas={personas}
            showScoreFilter={hasScoredCandidates}
            candidateCounts={candidateCounts}
            stageVisibility={stageVisibility}
            minScore={minScore}
            onRoleSelect={roleId => { selectRole(roleId); setShowMobileTools(false); }}
            onStageVisibilityChange={(stage, visible) => setStageVisibility(previous => ({ ...previous, [stage]: visible }))}
            onMinScoreChange={setMinScore}
            onOpenHiringSettings={() => {
              personaReturnFocusRef.current = mobileSettingsTriggerRef.current;
              setShowMobileTools(false);
              setShowSettings(true);
            }}
          />
        </DialogContent>
      </Dialog>

      {showSettings ? (
        <PersonaSettings
          persona={currentPersona}
          roleId={selectedRoleId}
          onSave={persona => {
            setPersonas(previous => ({ ...previous, [selectedRoleId]: persona }));
            setShowSettings(false);
            addToast(!interactiveDemoEnabled && demoStorageAvailable ? 'Demo settings saved in this browser. Applicant scoring is unchanged.' : 'Demo settings updated for this visit. Applicant scoring is unchanged.', 'success');
          }}
          onClose={() => setShowSettings(false)}
          returnFocusRef={personaReturnFocusRef}
          browserPersistence={!interactiveDemoEnabled && demoStorageAvailable}
        />
      ) : null}

      {hiredCandidate ? (
        <Dialog open={Boolean(showHiredModal)} onOpenChange={open => { if (!open) setShowHiredModal(null); }}>
          <DialogContent
            className="max-w-lg overflow-hidden rounded-[var(--radius-xl)] border border-[var(--cocoa-200)] bg-white p-0 shadow-[var(--shadow-modal)]"
            onCloseAutoFocus={event => { event.preventDefault(); hiredReturnFocusRef.current?.focus(); }}
          >
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
              {CONFETTI.map((piece, index) => (
                <span key={index} className="absolute top-0 h-2 w-1.5 animate-[confetti-fall_2s_ease-in_both]" style={{ left: piece.left, animationDelay: piece.delay, backgroundColor: piece.color, '--confetti-drift': piece.drift, '--confetti-spin': piece.spin } as React.CSSProperties} />
              ))}
            </div>
            <div className="relative p-6 text-center sm:p-8">
              <DialogClose asChild><button type="button" aria-label="Close hired confirmation" className="absolute right-4 top-4 flex size-10 items-center justify-center rounded-full text-[var(--cocoa-600)] hover:bg-[var(--cocoa-100)]"><X className="size-5" aria-hidden="true" /></button></DialogClose>
              <div className="mx-auto flex size-20 items-center justify-center rounded-full bg-[var(--cocoa-100)] text-[var(--cocoa-700)]"><Coffee className="size-10" strokeWidth={1.5} aria-hidden="true" /></div>
              <DialogTitle className="mt-5 font-display text-3xl font-semibold text-[var(--cocoa-900)]">Welcome to the team, {hiredCandidate.data.candidate.name.split(/\s+/u)[0]}! 🎉</DialogTitle>
              <DialogDescription className="mt-2 text-base leading-6 text-[var(--cocoa-600)]">{hiredCandidate.data.candidate.name} is now marked as hired for {getRoleById(hiredCandidate.data.candidate.applied_role || '')?.title ?? 'this role'}.{isDemoCandidateId(hiredCandidate.id) ? ' This is a fictional demo stage; no applicant was contacted.' : ''}</DialogDescription>
              <div className="mt-6 rounded-[var(--radius-lg)] bg-[var(--sage-50)] p-4 text-left">
                <p className="font-display text-lg font-semibold text-[var(--sage-700)]">What’s next</p>
                <ul className="mt-3 space-y-2 text-sm text-[var(--cocoa-700)]">
                  <li className="flex gap-2"><span aria-hidden="true">☐</span> Send them their start date via text</li>
                  <li className="flex gap-2"><span aria-hidden="true">☐</span> Add them to the schedule in Square</li>
                  <li className="flex gap-2"><span aria-hidden="true">☐</span> Set up their POS login</li>
                </ul>
              </div>
              <DialogClose asChild><button type="button" className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--cocoa-700)] px-5 font-semibold text-white hover:bg-[var(--cocoa-600)]"><Check className="size-4" aria-hidden="true" /> Done →</button></DialogClose>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
