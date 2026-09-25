'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Search, Settings, Upload } from 'lucide-react';

import { CAFE_ROLES, getRoleOrDefault } from '@/lib/domain/roles';
import type { HiringPersona } from '@/lib/domain/demo-workspace';

interface TopbarProps {
  selectedRoleId: string;
  personas?: Record<string, HiringPersona>;
  publicDemo?: boolean;
  onRoleSelect: (roleId: string) => void;
  onUpload: () => void;
  onSettings: () => void;
  settingsTriggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export function Topbar({ selectedRoleId, personas, publicDemo = false, onRoleSelect, onUpload, onSettings, settingsTriggerRef }: TopbarProps) {
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const roleMenuRef = useRef<HTMLDivElement>(null);
  const role = getRoleOrDefault(selectedRoleId);
  const wageForRole = (roleId: string) => {
    const persona = personas?.[roleId];
    return persona ? { min: persona.wageMin, max: persona.wageMax } : getRoleOrDefault(roleId).wageRange;
  };
  const wage = wageForRole(selectedRoleId);

  useEffect(() => {
    if (!roleMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!roleMenuRef.current?.contains(event.target as Node)) setRoleMenuOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [roleMenuOpen]);

  return (
    <header className="topbar-enter sticky top-0 z-50 h-16 border-b border-[var(--cocoa-200)] bg-[var(--cream-50)] shadow-[0_1px_0_var(--cocoa-100)]">
      <div className="mx-auto flex h-full max-w-[1600px] items-center justify-between gap-4 px-4 md:px-8">
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 44 44" className="size-11 shrink-0" role="img" aria-label="Cocoa Bakery CB monogram">
            <circle cx="22" cy="22" r="21" fill="var(--cocoa-100)" stroke="var(--cocoa-200)" />
            <text x="22" y="27" textAnchor="middle" fill="var(--cocoa-700)" fontFamily="var(--font-display), Georgia, serif" fontSize="14" fontWeight="700">CB</text>
          </svg>
          <div>
            <h1 className="font-display text-xl font-semibold leading-5 text-[var(--cocoa-900)]">Cocoa Bakery</h1>
            <p className="mt-0.5 text-xs text-[var(--cocoa-600)]">powered by TeamFlow</p>
          </div>
        </div>

        <div ref={roleMenuRef} className="relative hidden md:block">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={roleMenuOpen}
            onClick={() => setRoleMenuOpen(open => !open)}
            className="flex min-h-11 items-center gap-2 rounded-full border border-[var(--cocoa-300)] bg-[var(--cocoa-100)] px-4 text-sm font-semibold text-[var(--cocoa-800)] transition hover:bg-[var(--cocoa-200)]"
          >
            <span aria-hidden="true">{role.emoji}</span>
            <span>{role.title}</span>
            <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs text-[var(--cocoa-700)]">${wage.min}–${wage.max}/hr</span>
            <ChevronDown className={`size-4 transition-transform ${roleMenuOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          {roleMenuOpen ? (
            <div role="listbox" aria-label="Select active hiring role" className="absolute left-1/2 top-[calc(100%+10px)] z-50 w-72 -translate-x-1/2 rounded-[var(--radius-lg)] border border-[var(--cocoa-200)] bg-white p-2 shadow-[var(--shadow-modal)]">
              {CAFE_ROLES.map(option => (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={option.id === selectedRoleId}
                  onClick={() => { onRoleSelect(option.id); setRoleMenuOpen(false); }}
                  className={`flex min-h-12 w-full items-center gap-3 rounded-[var(--radius-md)] px-3 text-left text-sm transition ${option.id === selectedRoleId ? 'bg-[var(--cocoa-100)] text-[var(--cocoa-900)]' : 'text-[var(--cocoa-700)] hover:bg-[var(--cocoa-50)]'}`}
                >
                  <span aria-hidden="true">{option.emoji}</span>
                  <span className="flex-1 font-semibold">{option.title}</span>
                  <span className="text-xs">${wageForRole(option.id).min}–${wageForRole(option.id).max}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <button
            type="button"
            onClick={onUpload}
            className="flex min-h-10 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--cocoa-700)] px-4 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-px hover:bg-[var(--cocoa-600)] hover:shadow-md"
          >
            {publicDemo ? <Search className="size-4" aria-hidden="true" /> : <Upload className="size-4" aria-hidden="true" />} {publicDemo ? 'Explore sample resumes' : 'Upload Resumes'}
          </button>
          <button
            ref={settingsTriggerRef}
            type="button"
            onClick={onSettings}
            className="flex min-h-10 items-center gap-2 rounded-[var(--radius-md)] px-3 text-sm font-semibold text-[var(--cocoa-700)] hover:bg-[var(--cocoa-100)]"
          >
            <Settings className="size-4" aria-hidden="true" /> Settings
          </button>
        </div>

        <div className="md:hidden" aria-label={`Hiring for ${role.title}`}>
          <span className="rounded-full bg-[var(--cocoa-100)] px-3 py-1.5 text-xs font-semibold text-[var(--cocoa-700)]">{role.emoji} {role.title}</span>
        </div>
      </div>
    </header>
  );
}
