'use client';

import { useEffect, useState } from 'react';
import { Check, Upload, UserRoundCheck, WandSparkles, X } from 'lucide-react';

const STORAGE_KEY = 'teamflow-cocoa-onboarding-dismissed:v2';

interface OnboardingBannerProps {
  sampleCount: number;
  publicDemo?: boolean;
  onUpload: () => void;
  onSearch: () => void;
}

export function OnboardingBanner({ sampleCount, publicDemo = false, onUpload, onSearch }: OnboardingBannerProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        setVisible(window.localStorage.getItem(STORAGE_KEY) !== 'true');
      } catch {
        setVisible(true);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      // The banner can still be dismissed for this page view when storage is blocked.
    }
    setVisible(false);
  };

  return (
    <aside className="mb-6 rounded-[var(--radius-lg)] border border-[var(--cocoa-300)] bg-[var(--cocoa-100)] p-4 sm:p-5" aria-labelledby="welcome-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-[var(--cocoa-700)]">👋 Welcome to TeamFlow, Cocoa Bakery!</p>
          <h2 id="welcome-title" className="mt-1 font-display text-xl font-semibold text-[var(--cocoa-900)]">Meet your hiring workspace</h2>
          <p className="mt-1 text-sm text-[var(--cocoa-700)]">You’re viewing {sampleCount} sample applicants. Here’s how to get started:</p>
        </div>
        <button type="button" onClick={dismiss} aria-label="Dismiss welcome guide" className="flex size-10 shrink-0 items-center justify-center rounded-lg text-[var(--cocoa-600)] hover:bg-white/60">
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <ol className="mt-4 grid gap-3 md:grid-cols-3">
        <li className="flex gap-3 rounded-[var(--radius-md)] bg-white/60 p-3 text-sm text-[var(--cocoa-700)]">
          <Upload className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span><strong className="text-[var(--cocoa-900)]">Step 1</strong> — <button type="button" onClick={publicDemo ? onSearch : onUpload} className="font-semibold underline decoration-[var(--cocoa-300)] underline-offset-2">{publicDemo ? 'Search sample résumés' : 'Upload resumes'}</button> {publicDemo ? 'for the selected role.' : 'to add applicants.'}</span>
        </li>
        <li className="flex gap-3 rounded-[var(--radius-md)] bg-white/60 p-3 text-sm text-[var(--cocoa-700)]">
          <WandSparkles className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span><strong className="text-[var(--cocoa-900)]">Step 2</strong> — Read the evidence and try a simulated invitation.</span>
        </li>
        <li className="flex gap-3 rounded-[var(--radius-md)] bg-white/60 p-3 text-sm text-[var(--cocoa-700)]">
          <UserRoundCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span><strong className="text-[var(--cocoa-900)]">Step 3</strong> — Practice moving a fictional profile through the pipeline.</span>
        </li>
      </ol>
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={dismiss} className="inline-flex min-h-10 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--cocoa-700)] px-4 text-sm font-semibold text-white hover:bg-[var(--cocoa-600)]">
          <Check className="size-4" aria-hidden="true" /> Got it
        </button>
      </div>
    </aside>
  );
}
