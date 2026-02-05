"use client";

import { useState, useCallback } from 'react';
import { DropZone } from '@/components/drop-zone';
import { CandidateBoard, CandidateWithStatus, CandidateStatus } from '@/components/candidate-board';
import { PersonaSettings, HiringPersona } from '@/components/persona-settings';
import { Button } from '@/components/ui/button';
import { ParserOutput } from '@/app/api/types';

const defaultPersona: HiringPersona = {
  jobTitle: 'Barista',
  wageMin: 15,
  wageMax: 20,
  dealbreakers: ['Weekend availability required', 'Must be 18+'],
  niceToHaves: ['Previous barista experience', 'Latte art skills'],
  storeLocation: 'Jersey City, NJ',
};

// Demo candidates to showcase the dashboard
const demoCandidates: CandidateWithStatus[] = [
  {
    id: 'demo_1',
    status: 'new',
    data: {
      candidate: {
        name: 'Sarah Chen',
        email: 'sarah.chen@email.com',
        phone: '(201) 555-0123',
        city: 'Hoboken, NJ',
        skills: ['Espresso', 'Latte Art', 'Customer Service', 'POS Systems'],
        experience_years: 3,
      },
      score: {
        total: 92,
        breakdown: { constraints: 48, experience: 28, logistics: 16 },
        explanation: 'Excellent match. 3 years barista experience, latte art certified, lives 10 mins away. Available weekends.',
      },
      red_flags: [],
    },
  },
  {
    id: 'demo_2',
    status: 'new',
    data: {
      candidate: {
        name: 'Marcus Johnson',
        email: 'marcus.j@email.com',
        phone: '(201) 555-0456',
        city: 'Jersey City, NJ',
        skills: ['Barista', 'Team Lead', 'Inventory'],
        experience_years: 5,
      },
      score: {
        total: 87,
        breakdown: { constraints: 45, experience: 30, logistics: 12 },
        explanation: 'Strong candidate with leadership experience. Previously managed a team of 4. Weekend availability confirmed.',
      },
      red_flags: [],
    },
  },
  {
    id: 'demo_3',
    status: 'new',
    data: {
      candidate: {
        name: 'Alex Rivera',
        email: 'alex.r@email.com',
        phone: '(973) 555-0789',
        city: 'Newark, NJ',
        skills: ['Customer Service', 'Cash Handling'],
        experience_years: 1,
      },
      score: {
        total: 64,
        breakdown: { constraints: 40, experience: 15, logistics: 9 },
        explanation: 'Entry level, but eager to learn. No coffee experience but strong retail background. 25 min commute.',
      },
      red_flags: ['No coffee experience'],
    },
  },
  {
    id: 'demo_4',
    status: 'invited',
    data: {
      candidate: {
        name: 'Emily Park',
        email: 'emily.park@email.com',
        phone: '(201) 555-0321',
        city: 'Jersey City, NJ',
        skills: ['Barista', 'Latte Art', 'Food Safety Certified'],
        experience_years: 2,
      },
      score: {
        total: 88,
        breakdown: { constraints: 50, experience: 22, logistics: 16 },
        explanation: 'Great fit. Weekend & closing availability. Food handlers permit current. Lives 5 mins from store.',
      },
      red_flags: [],
    },
  },
  {
    id: 'demo_5',
    status: 'interviewed',
    data: {
      candidate: {
        name: 'James Wilson',
        email: 'jwilson@email.com',
        phone: '(201) 555-0654',
        city: 'Bayonne, NJ',
        skills: ['Coffee Roasting', 'Barista', 'Training'],
        experience_years: 4,
      },
      score: {
        total: 85,
        breakdown: { constraints: 45, experience: 28, logistics: 12 },
        explanation: 'Experienced with specialty coffee. Could help train new staff. Interviewed well, enthusiastic about the role.',
      },
      red_flags: [],
    },
  },
  {
    id: 'demo_6',
    status: 'hired',
    data: {
      candidate: {
        name: 'Maria Santos',
        email: 'maria.santos@email.com',
        phone: '(201) 555-0987',
        city: 'Jersey City, NJ',
        skills: ['Barista', 'Spanish Speaker', 'Opener'],
        experience_years: 2,
      },
      score: {
        total: 90,
        breakdown: { constraints: 50, experience: 24, logistics: 16 },
        explanation: 'Perfect schedule fit for morning shifts. Bilingual - great for our diverse customer base. Started last Monday!',
      },
      red_flags: [],
    },
  },
];

export default function Dashboard() {
  const [candidates, setCandidates] = useState<CandidateWithStatus[]>(demoCandidates);
  const [persona, setPersona] = useState<HiringPersona>(defaultPersona);
  const [showSettings, setShowSettings] = useState(false);

  const handleFileProcessed = useCallback((result: unknown) => {
    const newCandidate: CandidateWithStatus = {
      id: `candidate_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      data: result as ParserOutput,
      status: 'pending',
    };
    setCandidates(prev => [newCandidate, ...prev]);
  }, []);

  const handleStatusChange = useCallback((candidateId: string, newStatus: CandidateStatus) => {
    setCandidates(prev =>
      prev.map(c => c.id === candidateId ? { ...c, status: newStatus } : c)
    );
  }, []);

  const handleSavePersona = useCallback((newPersona: HiringPersona) => {
    setPersona(newPersona);
    setShowSettings(false);
    // TODO: Save to Supabase jobs table
    console.log('Persona saved:', newPersona);
  }, []);

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Header - Clean white with subtle border */}
      <header className="bg-white border-b border-stone-200 px-8 py-5 shadow-sm">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="text-3xl">🌿</span>
            <h1 className="text-2xl font-semibold text-stone-800 tracking-tight">TeamFlow</h1>
          </div>
          <div className="flex items-center gap-6">
            <div className="text-base text-stone-500">
              Hiring: <span className="text-stone-800 font-semibold text-lg">{persona.jobTitle}</span>
            </div>
            <Button
              variant="outline"
              size="default"
              onClick={() => setShowSettings(true)}
              className="text-base px-5 py-2 border-stone-300 text-stone-700 hover:bg-stone-100 hover:border-stone-400 rounded-xl"
            >
              ⚙️ Settings
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content - Generous spacing */}
      <main className="max-w-7xl mx-auto px-8 py-12">
        {/* Drop Zone Section */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-6 text-stone-700">
            📄 Upload Resumes
          </h2>
          <DropZone onFileProcessed={handleFileProcessed} />
        </section>

        {/* Candidates Section */}
        <section>
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-xl font-semibold text-stone-700">
              👥 Candidates <span className="text-stone-400 font-normal">({candidates.length})</span>
            </h2>
            <div className="text-base text-stone-400">
              Sorted by Fit Score
            </div>
          </div>
          <CandidateBoard
            candidates={candidates}
            onStatusChange={handleStatusChange}
          />
        </section>
      </main>

      {/* Persona Settings Modal */}
      {showSettings && (
        <PersonaSettings
          persona={persona}
          onSave={handleSavePersona}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
