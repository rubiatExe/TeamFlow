'use client';

import { Search, Upload, Users } from 'lucide-react';

export type DashboardTab = 'candidates' | 'upload' | 'search';

interface MainTabsProps {
  activeTab: DashboardTab;
  candidateCount: number;
  onTabChange: (tab: DashboardTab) => void;
}

const TABS = [
  { id: 'candidates' as const, label: 'Candidates', icon: Users },
  { id: 'upload' as const, label: 'Upload Resumes', icon: Upload },
  { id: 'search' as const, label: 'Smart Search', icon: Search },
];

export function MainTabs({ activeTab, candidateCount, onTabChange }: MainTabsProps) {
  return (
    <div className="hidden border-b border-[var(--cocoa-100)] md:block">
      <div role="tablist" aria-label="Hiring workspace" className="flex items-end gap-6">
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
              className={`relative flex min-h-14 items-center gap-2 border-b-[3px] px-1 text-sm transition-colors ${active ? 'border-[var(--cocoa-700)] font-semibold text-[var(--cocoa-800)]' : 'border-transparent text-[var(--cocoa-600)] hover:text-[var(--cocoa-800)]'}`}
            >
              <Icon className="size-4" aria-hidden="true" />
              {tab.label}{tab.id === 'candidates' ? ` (${candidateCount})` : ''}
            </button>
          );
        })}
      </div>
    </div>
  );
}
