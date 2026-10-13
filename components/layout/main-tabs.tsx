'use client';

import { ClipboardCheck, Search, Upload, Users } from 'lucide-react';

export type DashboardTab = 'candidates' | 'upload' | 'search' | 'review';

interface MainTabsProps {
  activeTab: DashboardTab;
  candidateCount: number;
  onTabChange: (tab: DashboardTab) => void;
}

const TABS = [
  { id: 'candidates' as const, label: 'Candidates', icon: Users },
  { id: 'upload' as const, label: 'Upload Resumes', icon: Upload },
  { id: 'search' as const, label: 'Smart Search', icon: Search },
  { id: 'review' as const, label: 'Review Queue', icon: ClipboardCheck },
];

export function MainTabs({ activeTab, candidateCount, onTabChange }: MainTabsProps) {
  return (
    <div className="hidden pt-5 md:block">
      <div role="tablist" aria-label="Hiring workspace" className="pill-tabs">
        {TABS.map(tab => {
          const active = activeTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`dashboard-panel-${tab.id}`}
              id={`dashboard-tab-${tab.id}`}
              onClick={() => onTabChange(tab.id)}
              className="pill-tab"
            >
              <Icon className="size-4" aria-hidden="true" />
              {tab.label}
              {tab.id === 'candidates' ? (
                <span className={`rounded-full px-2 py-0.5 text-xs tabular-nums ${active ? 'bg-white/20 text-white' : 'bg-[var(--cocoa-100)] text-[var(--cocoa-700)]'}`}>{candidateCount}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
