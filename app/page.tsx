"use client";

import { useState, useCallback, useMemo, useEffect } from 'react';
import { DropZone } from '@/components/drop-zone';
import { CandidateBoard, CandidateWithStatus, CandidateStatus } from '@/components/candidate-board';
import { PersonaSettings, HiringPersona } from '@/components/persona-settings';
import { SquareSettings } from '@/components/square-settings';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ParserOutput } from '@/app/api/types';
import { getRoleById, CAFE_ROLES } from '@/lib/roles';
import { demoCandidates } from '@/lib/demo-data';
import { loadCandidatesFromSupabase, DEMO_MERCHANT_ID, CandidateRow } from '@/lib/supabase';

const defaultPersona: HiringPersona = {
  jobTitle: 'Barista',
  wageMin: 15,
  wageMax: 20,
  dealbreakers: ['Weekend availability required', 'Must be 18+'],
  niceToHaves: ['Previous barista experience', 'Latte art skills'],
  storeLocation: 'Jersey City, NJ',
};

export default function Dashboard() {
  const [candidates, setCandidates] = useState<CandidateWithStatus[]>(demoCandidates);
  const [persona, setPersona] = useState<HiringPersona>(defaultPersona);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string>('job_barista');
  const [selectedRoleId, setSelectedRoleId] = useState<string>('barista');
  const [showHiredModal, setShowHiredModal] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(false);

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
              skills: (row.analysis as any)?.skills || [],
              experience_years: (row.analysis as any)?.experience_years,
              applied_role: (row.analysis as any)?.applied_role || row.job_id,
            },
            score: {
              total: row.fit_score || 0,
              breakdown: (row.analysis as any)?.breakdown || { constraints: 0, experience: 0, logistics: 0 },
              explanation: (row.analysis as any)?.explanation || row.summary,
            },
            red_flags: row.red_flags || [],
          }
        }));
        // Prepend fetched real candidates to demo ones
        setCandidates([...mapped, ...demoCandidates]);
      }
    }
    fetchCandidates();
  }, []);

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterRole, setFilterRole] = useState<string>('all');
  const [filterMinScore, setFilterMinScore] = useState<number>(0);

  // Comparison state
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);

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
    const topCandidate = candidates.reduce((best, c) =>
      (c.data.score?.total || 0) > (best.data.score?.total || 0) ? c : best
    , candidates[0]);

    return { total, byStatus, avgScore, topCandidate };
  }, [candidates]);

  const handleFileProcessed = useCallback((result: ParserOutput) => {
    const newCandidate: CandidateWithStatus = {
      id: `candidate_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      data: result,
      status: 'pending',
    };
    setCandidates(prev => [newCandidate, ...prev]);
  }, []);

  const handleStatusChange = useCallback((candidateId: string, newStatus: CandidateStatus) => {
    setCandidates(prev =>
      prev.map(c => c.id === candidateId ? { ...c, status: newStatus } : c)
    );
    if (newStatus === 'hired') {
      setShowHiredModal(candidateId);
    }
  }, []);

  const handleRemoveCandidate = useCallback((candidateId: string) => {
    setCandidates(prev => prev.filter(c => c.id !== candidateId));
    setCompareIds(prev => prev.filter(id => id !== candidateId));
  }, []);

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
              variant="outline"
              size="sm"
              onClick={() => setShowSidebar(!showSidebar)}
              className="md:hidden border-stone-300 text-stone-600 rounded-xl"
            >
              ◼️
            </Button>
            <Button
              variant="outline"
              size="default"
              onClick={() => setShowSettings(true)}
              className="text-sm md:text-base px-3 md:px-5 py-2 border-stone-300 text-stone-700 hover:bg-stone-100 hover:border-stone-400 rounded-xl"
            >
              ⚙️ <span className="hidden sm:inline ml-1">Settings</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Analytics Bar */}
      <div className="bg-white border-b border-stone-100 px-4 md:px-8 py-3">
        <div className="max-w-[1600px] mx-auto flex flex-wrap items-center gap-3 md:gap-6">
          <div className="flex items-center gap-2">
            <span className="text-stone-400 text-sm">Total:</span>
            <span className="font-semibold text-stone-800">{analytics.total}</span>
          </div>
          <div className="h-4 w-px bg-stone-200 hidden sm:block" />
          <div className="flex items-center gap-2">
            <span className="text-stone-400 text-sm">Avg Score:</span>
            <span className={`font-semibold ${analytics.avgScore >= 80 ? 'text-lime-600' : analytics.avgScore >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
              {analytics.avgScore}
            </span>
          </div>
          <div className="h-4 w-px bg-stone-200 hidden sm:block" />
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge className="bg-blue-50 text-blue-600 text-xs">🆕 {analytics.byStatus.new}</Badge>
            <Badge className="bg-amber-50 text-amber-600 text-xs">📧 {analytics.byStatus.invited}</Badge>
            <Badge className="bg-purple-50 text-purple-600 text-xs">🎤 {analytics.byStatus.interviewed}</Badge>
            <Badge className="bg-lime-50 text-lime-600 text-xs">✅ {analytics.byStatus.hired}</Badge>
          </div>
          <div className="h-4 w-px bg-stone-200 hidden sm:block" />
          {analytics.topCandidate && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-stone-400">Top:</span>
              <span className="font-medium text-stone-700">{analytics.topCandidate.data.candidate.name}</span>
              <span className="text-lime-600 font-semibold">{analytics.topCandidate.data.score.total}</span>
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
                📄 Upload Resumes
              </h2>
              <DropZone onFileProcessed={handleFileProcessed} roleId={selectedRoleId} />
            </section>

            {/* Search & Filter Bar */}
            <section className="mb-6">
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400">🔍</span>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search by name, email, or skill..."
                    className="w-full bg-white border border-stone-200 rounded-xl pl-10 pr-4 py-2.5 text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500 text-sm"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <select
                  value={filterRole}
                  onChange={e => setFilterRole(e.target.value)}
                  className="bg-white border border-stone-200 rounded-xl px-4 py-2.5 text-stone-700 text-sm focus:outline-none focus:ring-2 focus:ring-lime-500/50 cursor-pointer"
                >
                  <option value="all">All Roles</option>
                  {CAFE_ROLES.map(r => (
                    <option key={r.id} value={r.id}>{r.emoji} {r.title}</option>
                  ))}
                </select>
                <select
                  value={filterMinScore}
                  onChange={e => setFilterMinScore(Number(e.target.value))}
                  className="bg-white border border-stone-200 rounded-xl px-4 py-2.5 text-stone-700 text-sm focus:outline-none focus:ring-2 focus:ring-lime-500/50 cursor-pointer"
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
                <div className="mt-2 text-xs text-stone-400">
                  Showing {filteredCandidates.length} of {candidates.length} candidates
                  <button onClick={() => { setSearchQuery(''); setFilterRole('all'); setFilterMinScore(0); }}
                    className="ml-2 text-lime-600 hover:underline">Clear filters</button>
                </div>
              )}
            </section>

            {/* Candidates Section */}
            <section>
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg md:text-xl font-semibold text-stone-700">
                  👥 Candidates <span className="text-stone-400 font-normal">({filteredCandidates.length})</span>
                </h2>
                <div className="text-sm md:text-base text-stone-400">
                  Sorted by Fit Score
                </div>
              </div>
              <CandidateBoard
                candidates={filteredCandidates}
                onStatusChange={handleStatusChange}
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
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowSidebar(false)} />
          <div className="absolute right-0 top-0 bottom-0 w-80 bg-stone-50 p-4 overflow-y-auto shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-stone-800">Square Settings</h3>
              <button onClick={() => setShowSidebar(false)} className="text-stone-400 hover:text-stone-600">✕</button>
            </div>
            <SquareSettings
              onJobSelect={(job) => { handleJobSelect(job); setShowSidebar(false); }}
              selectedJobId={selectedJobId}
            />
          </div>
        </div>
      )}

      {/* Persona Settings Modal */}
      {showSettings && (
        <PersonaSettings
          persona={persona}
          onSave={handleSavePersona}
          onClose={() => setShowSettings(false)}
          roleId={selectedRoleId}
        />
      )}

      {/* Comparison Modal */}
      {showCompare && compareCandidates.length >= 2 && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-4xl w-full max-h-[90vh] overflow-y-auto shadow-2xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-stone-800">📊 Candidate Comparison</h2>
              <button onClick={() => { setShowCompare(false); setCompareIds([]); }}
                className="text-stone-400 hover:text-stone-600 text-lg">✕</button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-stone-200">
                    <th className="text-left py-3 px-4 text-stone-500 font-medium">Attribute</th>
                    {compareCandidates.map(c => (
                      <th key={c.id} className="text-center py-3 px-4 text-stone-800 font-semibold">
                        {c.data.candidate.name}
                        <div className="text-xs text-stone-400 font-normal mt-0.5">
                          {getRoleById(c.data.candidate.applied_role || '')?.emoji} {getRoleById(c.data.candidate.applied_role || '')?.title}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-stone-100">
                    <td className="py-3 px-4 text-stone-500">Total Score</td>
                    {compareCandidates.map(c => (
                      <td key={c.id} className={`py-3 px-4 text-center font-bold text-lg ${c.data.score.total >= 80 ? 'text-lime-600' : c.data.score.total >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                        {c.data.score.total}
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-stone-100">
                    <td className="py-3 px-4 text-stone-500">Constraints</td>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center text-stone-700">{c.data.score.breakdown.constraints}/50</td>
                    ))}
                  </tr>
                  <tr className="border-b border-stone-100">
                    <td className="py-3 px-4 text-stone-500">Experience</td>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center text-stone-700">{c.data.score.breakdown.experience}/30</td>
                    ))}
                  </tr>
                  <tr className="border-b border-stone-100">
                    <td className="py-3 px-4 text-stone-500">Logistics</td>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center text-stone-700">{c.data.score.breakdown.logistics}/20</td>
                    ))}
                  </tr>
                  <tr className="border-b border-stone-100">
                    <td className="py-3 px-4 text-stone-500">Experience (yrs)</td>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center text-stone-700">{c.data.candidate.experience_years || '—'}</td>
                    ))}
                  </tr>
                  <tr className="border-b border-stone-100">
                    <td className="py-3 px-4 text-stone-500">City</td>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center text-stone-700">{c.data.candidate.city || '—'}</td>
                    ))}
                  </tr>
                  <tr className="border-b border-stone-100">
                    <td className="py-3 px-4 text-stone-500">Skills</td>
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
                    <td className="py-3 px-4 text-stone-500">Red Flags</td>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center">
                        {c.data.red_flags?.length ? (
                          <div className="text-red-600 text-xs">{c.data.red_flags.map((f, i) => <span key={i}>⚠️ {f}<br/></span>)}</div>
                        ) : <span className="text-lime-600 text-xs">✓ None</span>}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="py-3 px-4 text-stone-500">Summary</td>
                    {compareCandidates.map(c => (
                      <td key={c.id} className="py-3 px-4 text-center text-xs text-stone-600 leading-relaxed">
                        {c.data.score.explanation}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Hired Confirmation Modal */}
      {showHiredModal && hiredCandidate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-8 max-w-md w-full mx-4 shadow-2xl">
            <div className="text-center">
              <div className="text-6xl mb-4">🎉</div>
              <h2 className="text-2xl font-bold text-stone-800 mb-2">
                Welcome to the Team!
              </h2>
              <p className="text-stone-600 mb-6">
                <strong>{hiredCandidate.data.candidate.name}</strong> has been added to Square Team
                {hiredCandidate.data.candidate.applied_role && (
                  <span className="block text-sm text-stone-400 mt-1">
                    Role: {getRoleById(hiredCandidate.data.candidate.applied_role)?.emoji}{' '}
                    {getRoleById(hiredCandidate.data.candidate.applied_role)?.title}
                  </span>
                )}
              </p>

              <div className="bg-lime-50 rounded-xl p-4 mb-6 text-left">
                <h3 className="font-semibold text-lime-800 mb-2">✓ Onboarding Complete</h3>
                <ul className="text-sm text-lime-700 space-y-1">
                  <li>• POS login created</li>
                  <li>• Time clock access enabled</li>
                  <li>• Schedule added to Team Calendar</li>
                </ul>
              </div>

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1 rounded-xl"
                  onClick={() => setShowHiredModal(null)}
                >
                  Close
                </Button>
                <Button
                  className="flex-1 bg-lime-500 hover:bg-lime-600 text-white rounded-xl"
                  onClick={() => {
                    setShowHiredModal(null);
                    window.open('https://squareup.com/dashboard/team', '_blank');
                  }}
                >
                  View in Square →
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
