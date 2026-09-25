'use client';

import { Search, Settings, Upload, Users } from 'lucide-react';

import type { DashboardTab } from '@/components/layout/main-tabs';

interface BottomNavProps {
  activeTab: DashboardTab;
  settingsOpen: boolean;
  onTabChange: (tab: DashboardTab) => void;
  onSettings: () => void;
  settingsTriggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export function BottomNav({ activeTab, settingsOpen, onTabChange, onSettings, settingsTriggerRef }: BottomNavProps) {
  const items = [
    { id: 'candidates' as const, label: 'Candidates', icon: Users },
    { id: 'upload' as const, label: 'Upload', icon: Upload },
    { id: 'search' as const, label: 'Search', icon: Search },
  ];

  return (
    <nav aria-label="Mobile hiring workspace" className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--cocoa-200)] bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      <div className="grid h-16 grid-cols-4">
        {items.map(item => {
          const active = activeTab === item.id && !settingsOpen;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onTabChange(item.id)}
              className={`flex min-h-12 flex-col items-center justify-center gap-1 text-[11px] font-semibold ${active ? 'text-[var(--cocoa-700)]' : 'text-[var(--cocoa-500)]'}`}
            >
              <Icon className={`size-5 ${active ? 'fill-[var(--cocoa-100)]' : ''}`} aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
        <button
          ref={settingsTriggerRef}
          type="button"
          aria-expanded={settingsOpen}
          onClick={onSettings}
          className={`flex min-h-12 flex-col items-center justify-center gap-1 text-[11px] font-semibold ${settingsOpen ? 'text-[var(--cocoa-700)]' : 'text-[var(--cocoa-500)]'}`}
        >
          <Settings className={`size-5 ${settingsOpen ? 'fill-[var(--cocoa-100)]' : ''}`} aria-hidden="true" />
          Settings
        </button>
      </div>
    </nav>
  );
}
