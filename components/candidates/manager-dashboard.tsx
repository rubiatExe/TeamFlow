"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { DropZone } from '@/components/candidates/drop-zone';
import { CandidateBoard } from '@/components/candidates/candidate-board';
import { PersonaSettings, HiringPersona } from '@/components/hiring-personas/persona-settings';
import { SquareSettings } from '@/components/hiring-personas/square-settings';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { ParserOutput } from '@/lib/contracts/parser';
import type { CandidateStatus, CandidateWithStatus } from '@/lib/contracts/candidate';
import { getRoleById, CAFE_ROLES } from '@/lib/domain/roles';
import { demoCandidates } from '@/lib/domain/demo-data';
import { loadCandidatesFromSupabase, deleteCandidateFromSupabase, updateCandidateStatus, DEMO_MERCHANT_ID, CandidateRow } from '@/lib/db/supabase';

const defaultPersona: HiringPersona = {
  jobTitle: 'Barista',
  wageMin: 15,
  wageMax: 20,
  dealbreakers: ['Weekend availability required', 'Valid work authorization'],
  niceToHaves: ['Previous barista experience', 'Latte art skills'],
  storeLocation: '475 Central Ave, Jersey City, NJ 07307',
};

export function ManagerDashboard() {
  const { addToast } = useToast();
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const candidateSearchRef = useRef<HTMLInputElement>(null);
  const hiredReturnFocusRef = useRef<HTMLElement | null>(null);
  const [candidates, setCandidates] = useState<CandidateWithStatus[]>(demoCandidates);
  const [persona, setPersona] = useState<HiringPersona>(defaultPersona);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string>('job_barista');
  const [selectedRoleId, setSelectedRoleId] = useState<string>('barista');
  const [showHiredModal, setShowHiredModal] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);

  useEffect(() => {
    async function fetchCandidates() {
      const rows = await loadCandidatesFromSupabase(DEMO_MERCHANT_ID);
      if (rows && rows.length > 0) {
        const mapped: CandidateWithStatus[] = rows.map((row: CandidateRow) => ({
          id: row.id || `candidate_${Date.now()}`,
          status: (row.status as CandidateStatus) || 'new',
          data: {
            candidate: {
              name: row.name,
              email: row.email,
              phone: row.phone,
              city: row.city,
              skills: row.analysis?.skills || [],
              experience_years: row.analysis?.experience_years,
              applied_role: row.analysis?.applied_role || row.job_id,
            },
            score: {
              total: row.fit_score || 0,
              breakdown: row.analysis?.breakdown || { constraints: 0, experience: 0, logistics: 0 },
              explanation: row.analysis?.explanation || row.summary || '',
            },
            red_flags: row.red_flags || [],
          }
        }));
        // Real records replace the clearly labeled synthetic sample set.
        setCandidates(mapped);
      }
    }
    fetchCandidates();
  }, []);

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterRole, setFilterRole] = useState<string>('all');
  const [filterMinScore, setFilterMinScore] = useState<number>(0);

  // Filtered candidates
  const filteredCandidates = useMemo(() => {
    return candidates.filter(c => {
      // Search
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const nameMatch = c.data.candidate.name.toLowerCase().includes(q);
        const emailMatch = c.data.candidate.email?.toLowerCase().includes(q);
        const skillMatch = c.data.candidate.skills?.some(s => s.toLowerCase().includes(q));
        if (!nameMatch && !emailMatch && !skillMatch) return false;
      }
      // Role filter
      if (filterRole !== 'all' && c.data.candidate.applied_role !== filterRole) return false;
      // Score filter
      if (c.data.score.total < filterMinScore) return false;
      return true;
    });
  }, [candidates, searchQuery, filterRole, filterMinScore]);

  // Analytics
  const analytics = useMemo(() => {
    const total = candidates.length;
    const byStatus = {
      pending: candidates.filter(c => c.status === 'pending').length,
      new: candidates.filter(c => c.status === 'new').length,
      invited: candidates.filter(c => c.status === 'invited').length,
      interviewed: candidates.filter(c => c.status === 'interviewed').length,
      hired: candidates.filter(c => c.status === 'hired').length,
    };
    const avgScore = total > 0
      ? Math.round(candidates.reduce((sum, c) => sum + (c.data.score?.total || 0), 0) / total)
      : 0;

    const roleCandidates = candidates.filter(c => c.data.candidate.applied_role === selectedRoleId);
    const topCandidate = roleCandidates.reduce((best, c) =>
      (c.data.score?.total || 0) > (best?.data?.score?.total || 0) ? c : best
    , roleCandidates[0]);

    return { total, byStatus, avgScore, topCandidate };
  }, [candidates, selectedRoleId]);

  const handleFileProcessed = useCallback((result: ParserOutput) => {
    const newCandidate: CandidateWithStatus = {
      id: `candidate_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      data: result,
      status: 'pending',
    };
    setCandidates(prev => [newCandidate, ...prev]);
  }, []);

  const commitLocalStatus = useCallback((candidateId: string, newStatus: CandidateStatus) => {
    setCandidates(prev =>
      prev.map(c => c.id === candidateId ? { ...c, status: newStatus } : c)
    );
    if (newStatus === 'hired') {
      hiredReturnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      setShowHiredModal(candidateId);
    }
  }, []);

  const handleStatusChange = useCallback(async (candidateId: string, newStatus: CandidateStatus) => {
    if (candidateId.startsWith('demo_')) {
      commitLocalStatus(candidateId, newStatus);
      addToast('Synthetic demo status changed locally; no hiring system was updated.', 'info');
      return;
    }

    const updated = await updateCandidateStatus(candidateId, newStatus);
    if (!updated) {
      addToast('Status was not saved. The candidate card was not changed.', 'error');
      return;
    }
    commitLocalStatus(candidateId, newStatus);
  }, [addToast, commitLocalStatus]);

  const handleInviteSuccess = useCallback((candidateId: string) => {
    setCandidates(prev => prev.map(candidate => (
      candidate.id === candidateId ? { ...candidate, status: 'invited' } : candidate
    )));
  }, []);

  const handleRemoveCandidate = useCallback(async (candidateId: string) => {
    if (!candidateId.startsWith('demo_')) {
      const deleted = await deleteCandidateFromSupabase(candidateId);
      if (!deleted) {
        addToast('Candidate was not removed because the deletion was not saved.', 'error');
        return;
      }
    } else {
      addToast('Synthetic demo record removed locally.', 'info');
    }
    setCandidates(prev => prev.filter(c => c.id !== candidateId));
    setCompareIds(prev => prev.filter(id => id !== candidateId));
  }, [addToast]);

  const handleSavePersona = useCallback((newPersona: HiringPersona) => {
    setPersona(newPersona);
    setShowSettings(false);
  }, []);

  const handleJobSelect = useCallback((job: { id: string; title: string; wageMin: number; wageMax: number; roleId?: string }) => {
    setSelectedJobId(job.id);
    const jobRoleId = job.roleId || 'barista';
    setSelectedRoleId(jobRoleId);
    const role = getRoleById(jobRoleId);
    if (role) {
      setPersona(prev => ({
        ...prev,
        jobTitle: role.title,
        wageMin: role.wageRange.min,
        wageMax: role.wageRange.max,
        dealbreakers: role.dealbreakers,
      }));
    }
  }, []);

  const hiredCandidate = showHiredModal ? candidates.find(c => c.id === showHiredModal) : null;
  const currentRole = getRoleById(selectedRoleId);
  const compareCandidates = compareIds.map(id => candidates.find(c => c.id === id)).filter(Boolean) as CandidateWithStatus[];
  const hasSyntheticDemoRecords = candidates.some(candidate => candidate.id.startsWith('demo_'));

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 px-4 md:px-8 py-4 md:py-5 shadow-sm">
        <div className="max-w-[1600px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3 md:gap-4">
            <span className="text-2xl md:text-3xl">🌿</span>
            <h1 className="text-xl md:text-2xl font-semibold text-stone-800 tracking-tight">TeamFlow</h1>
          </div>
          <div className="flex items-center gap-3 md:gap-6">
            <div className="text-sm md:text-base text-stone-500 hidden sm:block">
              Hiring: <span className="text-stone-800 font-semibold">{currentRole?.emoji} {persona.jobTitle}</span>
            </div>
            <Button
              ref={sidebarTriggerRef}
              variant="outline"
              size="sm"
              aria-label="Open job settings"
              aria-expanded={showSidebar}
              onClick={() => setShowSidebar(!showSidebar)}
              className="min-h-11 min-w-11 md:hidden border-stone-300 text-stone-600 rounded-xl"
            >
              ◼️
            </Button>
            <Button
              ref={settingsTriggerRef}
              variant="outline"
              size="default"
              aria-label="Open hiring persona settings"
              onClick={() => setShowSettings(true)}
              className="min-h-11 min-w-11 text-sm md:text-base px-3 md:px-5 py-2 border-stone-300 text-stone-700 hover:bg-stone-100 hover:border-stone-400 rounded-xl"
            >
              ⚙️ <span className="hidden sm:inline ml-1">Settings</span>
            </Button>
          </div>
        </div>
      </header>

      <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm font-medium text-amber-950" role="note">
        Local demo: {hasSyntheticDemoRecords ? 'synthetic candidate records and ' : ''}uncalibrated scores are shown for interface testing only. Do not use them for hiring decisions.
      </div>

      {/* Analytics Bar */}
      <div className="bg-white border-b border-stone-100 px-4 md:px-8 py-3">
        <div className="max-w-[1600px] mx-auto flex flex-wrap items-center gap-3 md:gap-6">
          <div className="flex items-center gap-2">
            <span className="text-stone-600 text-sm">Total:</span>
            <span className="font-semibold text-stone-800">{analytics.total}</span>
          </div>
          <div className="h-4 w-px bg-stone-200 hidden sm:block" />
          <div className="flex items-center gap-2">
            <span className="text-stone-600 text-sm">Avg demo score:</span>
            <span className={`font-semibold ${analytics.avgScore >= 80 ? 'text-lime-800' : analytics.avgScore >= 50 ? 'text-amber-800' : 'text-red-700'}`}>
              {analytics.avgScore}
            </span>
          </div>
          <div className="h-4 w-px bg-stone-200 hidden sm:block" />
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge className="bg-blue-50 text-blue-800 text-xs">🆕 {analytics.byStatus.new}</Badge>
            <Badge className="bg-amber-50 text-amber-800 text-xs">📧 {analytics.byStatus.invited}</Badge>
            <Badge className="bg-purple-50 text-purple-600 text-xs">🎤 {analytics.byStatus.interviewed}</Badge>
            <Badge className="bg-lime-50 text-lime-800 text-xs">✅ {analytics.byStatus.hired}</Badge>
          </div>
          <div className="h-4 w-px bg-stone-200 hidden sm:block" />
          {analytics.topCandidate && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-stone-600">Top demo score:</span>
              <span className="font-medium text-stone-700">{analytics.topCandidate.data.candidate.name}</span>
              <span className="text-lime-800 font-semibold">{analytics.topCandidate.data.score.total}</span>
            </div>
          )}
        </div>
      </div>

      {/* Main Content with Side Panel */}
      <main className="max-w-[1600px] mx-auto px-4 md:px-8 py-6 md:py-8">
        <div className="flex gap-8">
          {/* Left Side - Main Content */}
          <div className="flex-1 min-w-0">
            {/* Drop Zone Section */}
            <section className="mb-8 md:mb-10">
              <h2 className="text-lg md:text-xl font-semibold mb-4 md:mb-5 text-stone-700">
                📄 Process resumes (local demo)
              </h2>
              <DropZone onFileProcessed={handleFileProcessed} roleId={selectedRoleId} />
            </section>

            {/* Search & Filter Bar */}
            <section className="mb-6">
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <span aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-600">🔍</span>
                  <label htmlFor="candidate-search" className="sr-only">Search candidates</label>
                  <input
                    ref={candidateSearchRef}
                    id="candidate-search"
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search by name, email, or skill..."
                    className="min-h-11 w-full bg-white border border-stone-300 rounded-xl pl-10 pr-12 py-2.5 text-stone-800 placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-lime-600 focus:border-lime-600 text-sm"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      aria-label="Clear candidate search"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-1 top-1/2 min-h-11 min-w-11 -translate-y-1/2 rounded-lg text-stone-600 hover:bg-stone-100 hover:text-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <select
                  aria-label="Filter candidates by role"
                  value={filterRole}
                  onChange={e => setFilterRole(e.target.value)}
                  className="min-h-11 bg-white border border-stone-300 rounded-xl px-4 py-2.5 text-stone-700 text-sm focus:outline-none focus:ring-2 focus:ring-lime-600 cursor-pointer"
                >
                  <option value="all">All Roles</option>
                  {CAFE_ROLES.map(r => (
                    <option key={r.id} value={r.id}>{r.emoji} {r.title}</option>
                  ))}
                </select>
                <select
                  aria-label="Filter candidates by minimum demo score"
                  value={filterMinScore}
                  onChange={e => setFilterMinScore(Number(e.target.value))}
                  className="min-h-11 bg-white border border-stone-300 rounded-xl px-4 py-2.5 text-stone-700 text-sm focus:outline-none focus:ring-2 focus:ring-lime-600 cursor-pointer"
                >
                  <option value={0}>Any Score</option>
                  <option value={50}>Score 50+</option>
                  <option value={70}>Score 70+</option>
                  <option value={80}>Score 80+</option>
                  <option value={90}>Score 90+</option>
                </select>
                {compareIds.length > 0 && (
                  <Button
                    onClick={() => setShowCompare(true)}
                    className="bg-blue-500 hover:bg-blue-600 text-white rounded-xl text-sm px-4"
                  >
                    Compare ({compareIds.length})
                  </Button>
                )}
              </div>
              {(searchQuery || filterRole !== 'all' || filterMinScore > 0) && (
                <div className="mt-2 text-xs text-stone-600">
                  Showing {filteredCandidates.length} of {candidates.length} candidates
                  <button onClick={() => { setSearchQuery(''); setFilterRole('all'); setFilterMinScore(0); }}
                    type="button"
                    className="ml-2 min-h-11 text-lime-700 hover:underline">Clear filters</button>
                </div>
              )}
            </section>

            {/* Candidates Section */}
            <section>
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg md:text-xl font-semibold text-stone-700">
                  👥 Candidates <span className="text-stone-600 font-normal">({filteredCandidates.length})</span>
                </h2>
                <div className="text-sm md:text-base text-stone-600">
                  Sorted by uncalibrated demo score
                </div>
              </div>
              <CandidateBoard
                candidates={filteredCandidates}
                onStatusChange={handleStatusChange}
                onInviteSuccess={handleInviteSuccess}
                onRemove={handleRemoveCandidate}
              />
            </section>
          </div>

          {/* Right Side - Square Settings (desktop) */}
          <div className="w-80 flex-shrink-0 hidden lg:block">
            <SquareSettings
              onJobSelect={handleJobSelect}
              selectedJobId={selectedJobId}
            />
          </div>
        </div>
      </main>

      {/* Mobile Sidebar Overlay */}
      {showSidebar && (
        <Dialog open={showSidebar} onOpenChange={setShowSidebar}>
          <DialogContent
            className="left-auto right-0 top-0 h-dvh w-full max-w-80 translate-x-0 translate-y-0 overflow-y-auto bg-stone-50 p-4 shadow-xl"
            onCloseAutoFocus={event => {
              event.preventDefault();
              sidebarTriggerRef.current?.focus();
            }}
          >
            <div className="flex justify-between items-center mb-4">
              <DialogTitle>Job settings</DialogTitle>
              <DialogClose asChild>
                <button type="button" aria-label="Close job settings" className="min-h-11 min-w-11 rounded-lg text-stone-600 hover:bg-stone-100 hover:text-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600">✕</button>
              </DialogClose>
            </div>
            <DialogDescription className="sr-only">
              Select the local demo job configuration used by the dashboard.
            </DialogDescription>
            <SquareSettings
              onJobSelect={(job) => { handleJobSelect(job); setShowSidebar(false); }}
              selectedJobId={selectedJobId}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Persona Settings Modal */}
      {showSettings && (
        <PersonaSettings
          persona={persona}
          onSave={handleSavePersona}
          onClose={() => setShowSettings(false)}
          roleId={selectedRoleId}
          returnFocusRef={settingsTriggerRef}
        />
      )}

      {/* Comparison Modal */}
      {showCompare && compareCandidates.length >= 2 && (
        <Dialog
          open={showCompare}
          onOpenChange={open => {
            setShowCompare(open);
            if (!open) setCompareIds([]);
          }}
        >
          <DialogContent
            className="max-w-4xl min-w-0 max-h-[90vh] overflow-y-auto bg-white rounded-2xl p-4 sm:p-6 shadow-2xl"
            onCloseAutoFocus={event => {
              event.preventDefault();
              candidateSearchRef.current?.focus();
            }}
          >
            <div className="flex justify-between items-center mb-6">
              <DialogTitle className="text-xl font-bold">📊 Candidate comparison</DialogTitle>
              <DialogClose asChild>
                <button type="button" aria-label="Close candidate comparison"
                  className="min-h-11 min-w-11 rounded-lg text-stone-600 hover:bg-stone-100 hover:text-stone-800 text-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600">✕</button>
              </DialogClose>
            </div>
            <DialogDescription className="sr-only">
              Compare synthetic local demo candidate attributes and uncalibrated scores.
            </DialogDescription>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Synthetic local demo candidate attributes and uncalibrated comparison scores
                </caption>
                <thead>
                  <tr className="border-b border-stone-200">
                    <th scope="col" className="text-left py-3 px-4 text-stone-500 font-medium">Attribute</th>
                    {compareCandidates.map(c => (
                      <th scope="col" key={c.id} className="text-center py-3 px-4 text-stone-800 font-semibold">
                        {c.data.candidate.name}
                        <div className="text-xs text-stone-600 font-normal mt-0.5">
                          {getRoleById(c.data.candidate.applied_role || '')?.emoji} {getRoleById(c.data.candidate.applied_role || '')?.title}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-stone-100">
                    <th scope="row" className="py-3 px-4 text-left font-normal text-stone-500">Total Score</th>
                    {compareCandidates.map(c => (
                      <td key={c.id} className={`py-3 px-4 text-center font-bold text-lg ${c.data.score.total >= 80 ? 'text-lime-600' : c.data.score.total >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                        {c.data.score.total}
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-stone-100">
                    <th scope="row" className="py-3 px-4 text-left font-normal text-stone-500">Constraints</th>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center text-stone-700">{c.data.score.breakdown.constraints}/50</td>
                    ))}
                  </tr>
                  <tr className="border-b border-stone-100">
                    <th scope="row" className="py-3 px-4 text-left font-normal text-stone-500">Experience</th>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center text-stone-700">{c.data.score.breakdown.experience}/30</td>
                    ))}
                  </tr>
                  <tr className="border-b border-stone-100">
                    <th scope="row" className="py-3 px-4 text-left font-normal text-stone-500">Logistics</th>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center text-stone-700">{c.data.score.breakdown.logistics}/20</td>
                    ))}
                  </tr>
                  <tr className="border-b border-stone-100">
                    <th scope="row" className="py-3 px-4 text-left font-normal text-stone-500">Experience (yrs)</th>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center text-stone-700">{c.data.candidate.experience_years || '—'}</td>
                    ))}
                  </tr>
                  <tr className="border-b border-stone-100">
                    <th scope="row" className="py-3 px-4 text-left font-normal text-stone-500">City</th>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center text-stone-700">{c.data.candidate.city || '—'}</td>
                    ))}
                  </tr>
                  <tr className="border-b border-stone-100">
                    <th scope="row" className="py-3 px-4 text-left font-normal text-stone-500">Skills</th>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center">
                        <div className="flex flex-wrap gap-1 justify-center">
                          {c.data.candidate.skills?.map((s, i) => (
                            <Badge key={i} variant="secondary" className="text-xs bg-stone-100 text-stone-600">{s}</Badge>
                          ))}
                        </div>
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-stone-100">
                    <th scope="row" className="py-3 px-4 text-left font-normal text-stone-500">Red Flags</th>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center">
                        {c.data.red_flags?.length ? (
                          <div className="text-red-600 text-xs">{c.data.red_flags.map((f, i) => <span key={i}>⚠️ {f}<br/></span>)}</div>
                        ) : <span className="text-lime-800 text-xs">✓ None</span>}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row" className="py-3 px-4 text-left font-normal text-stone-500">Summary</th>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center text-xs text-stone-600 leading-relaxed">
                        {c.data.score.explanation}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Hired Confirmation Modal */}
      {showHiredModal && hiredCandidate && (
        <Dialog open={Boolean(showHiredModal)} onOpenChange={open => !open && setShowHiredModal(null)}>
          <DialogContent
            className="max-w-md min-w-0 bg-white rounded-2xl p-5 sm:p-8 shadow-2xl"
            onCloseAutoFocus={event => {
              event.preventDefault();
              hiredReturnFocusRef.current?.focus();
            }}
          >
            <div className="text-center">
              <div aria-hidden="true" className="text-6xl mb-4">✓</div>
              <DialogTitle className="text-2xl font-bold mb-2">
                Candidate status updated
              </DialogTitle>
              <DialogDescription className="text-base text-stone-600 mb-6">
                <strong>{hiredCandidate.data.candidate.name}</strong> is now marked as hired in this {hiredCandidate.id.startsWith('demo_') ? 'local demo' : 'candidate record'}.
                {hiredCandidate.data.candidate.applied_role && (
                  <span className="block text-sm text-stone-600 mt-1">
                    Role: {getRoleById(hiredCandidate.data.candidate.applied_role)?.emoji}{' '}
                    {getRoleById(hiredCandidate.data.candidate.applied_role)?.title}
                  </span>
                )}
              </DialogDescription>

              <div className="bg-amber-50 rounded-xl p-4 mb-6 text-left text-sm text-amber-950">
                No onboarding, account creation, scheduling, or calendar action was performed.
              </div>

              <div className="flex gap-3">
                <DialogClose asChild>
                  <Button variant="outline" className="min-h-11 flex-1 rounded-xl">Close</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button className="min-h-11 flex-1 bg-lime-500 hover:bg-lime-600 text-white rounded-xl">Done →</Button>
                </DialogClose>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
