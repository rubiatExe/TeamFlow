'use client';

import { useRef, useState } from 'react';
import { Check, CircleDollarSign, MapPin, Plus, Save, Sparkles, X } from 'lucide-react';

import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { getRoleOrDefault } from '@/lib/domain/roles';

export interface HiringPersona {
  jobTitle: string;
  wageMin: number;
  wageMax: number;
  dealbreakers: string[];
  niceToHaves: string[];
  storeLocation: string;
}

interface PersonaSettingsProps {
  persona: HiringPersona;
  onSave: (persona: HiringPersona) => void;
  onClose: () => void;
  roleId?: string;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

type SettingsTab = 'role' | 'dealbreakers' | 'nice';

export function PersonaSettings({ persona, onSave, onClose, roleId, returnFocusRef }: PersonaSettingsProps) {
  const role = getRoleOrDefault(roleId);
  const firstTabRef = useRef<HTMLButtonElement>(null);
  const roleNiceToHaves = role.niceToHaveSkills.map(skill => skill.label.replace(/^\S+\s*/u, ''));
  const [activeTab, setActiveTab] = useState<SettingsTab>('role');
  const [customValue, setCustomValue] = useState('');
  const [formData, setFormData] = useState<HiringPersona>({
    ...persona,
    jobTitle: role.title,
    wageMin: persona.jobTitle === role.title ? persona.wageMin : role.wageRange.min,
    wageMax: persona.jobTitle === role.title ? persona.wageMax : role.wageRange.max,
    dealbreakers: persona.jobTitle === role.title ? persona.dealbreakers : role.dealbreakers,
    niceToHaves: persona.jobTitle === role.title ? persona.niceToHaves : roleNiceToHaves,
  });

  const tabs = [
    { id: 'role' as const, label: 'Role & Pay', icon: CircleDollarSign },
    { id: 'dealbreakers' as const, label: 'Dealbreakers', icon: X },
    { id: 'nice' as const, label: 'Nice-to-Haves', icon: Sparkles },
  ];

  const toggleValue = (field: 'dealbreakers' | 'niceToHaves', value: string) => {
    setFormData(previous => ({
      ...previous,
      [field]: previous[field].includes(value)
        ? previous[field].filter(item => item !== value)
        : [...previous[field], value],
    }));
  };

  const addCustom = () => {
    const value = customValue.trim();
    if (!value) return;
    const field = activeTab === 'dealbreakers' ? 'dealbreakers' : 'niceToHaves';
    setFormData(previous => previous[field].includes(value) ? previous : { ...previous, [field]: [...previous[field], value] });
    setCustomValue('');
  };

  const wageError = formData.wageMin < 0 || formData.wageMax < formData.wageMin;

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent
        className="max-h-[92vh] max-w-3xl overflow-hidden rounded-[var(--radius-xl)] border border-[var(--cocoa-200)] bg-[var(--cream-50)] p-0 shadow-[var(--shadow-modal)]"
        onOpenAutoFocus={event => { event.preventDefault(); firstTabRef.current?.focus(); }}
        onCloseAutoFocus={event => {
          if (!returnFocusRef?.current) return;
          event.preventDefault();
          returnFocusRef.current.focus();
        }}
      >
        <div className="border-b border-[var(--cocoa-100)] bg-white px-5 py-5 sm:px-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogTitle className="font-display text-2xl font-semibold text-[var(--cocoa-900)]">Hiring Settings for {role.emoji} {role.title}</DialogTitle>
              <DialogDescription className="mt-1 text-sm text-[var(--cocoa-600)]">These demo settings describe the review criteria shown for this role.</DialogDescription>
            </div>
            <DialogClose asChild>
              <button type="button" aria-label="Close hiring settings" className="flex size-10 shrink-0 items-center justify-center rounded-full text-[var(--cocoa-600)] hover:bg-[var(--cocoa-100)]"><X className="size-5" aria-hidden="true" /></button>
            </DialogClose>
          </div>
        </div>

        <form onSubmit={event => { event.preventDefault(); if (!wageError) onSave(formData); }} className="flex max-h-[calc(92vh-104px)] min-h-[460px] flex-col sm:flex-row">
          <div role="tablist" aria-label="Hiring setting sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--cocoa-100)] bg-[var(--cocoa-50)] p-3 sm:w-48 sm:flex-col sm:border-b-0 sm:border-r sm:p-4">
            {tabs.map((tab, index) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  ref={index === 0 ? firstTabRef : undefined}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => { setActiveTab(tab.id); setCustomValue(''); }}
                  className={`flex min-h-11 shrink-0 items-center gap-2 rounded-[var(--radius-md)] px-3 text-left text-sm font-semibold ${active ? 'bg-[var(--cocoa-700)] text-white' : 'text-[var(--cocoa-700)] hover:bg-[var(--cocoa-100)]'}`}
                >
                  <Icon className="size-4" aria-hidden="true" /> {tab.label}
                </button>
              );
            })}
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto bg-white p-5 sm:p-7">
            {activeTab === 'role' ? (
              <section role="tabpanel" aria-label="Role and pay" className="space-y-5">
                <div>
                  <label htmlFor="persona-job-title" className="text-sm font-semibold text-[var(--cocoa-800)]">Job title</label>
                  <input id="persona-job-title" value={formData.jobTitle} readOnly className="mt-2 min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--cocoa-200)] bg-[var(--cocoa-50)] px-4 text-sm text-[var(--cocoa-700)]" />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="persona-wage-min" className="text-sm font-semibold text-[var(--cocoa-800)]">Minimum wage ($/hr)</label>
                    <input id="persona-wage-min" type="number" min="0" value={formData.wageMin} onChange={event => setFormData(previous => ({ ...previous, wageMin: Number(event.target.value) }))} className="mt-2 min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--cocoa-200)] bg-white px-4 text-sm text-[var(--cocoa-800)]" />
                  </div>
                  <div>
                    <label htmlFor="persona-wage-max" className="text-sm font-semibold text-[var(--cocoa-800)]">Maximum wage ($/hr)</label>
                    <input id="persona-wage-max" type="number" min="0" value={formData.wageMax} onChange={event => setFormData(previous => ({ ...previous, wageMax: Number(event.target.value) }))} className="mt-2 min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--cocoa-200)] bg-white px-4 text-sm text-[var(--cocoa-800)]" />
                  </div>
                </div>
                {wageError ? <p role="alert" className="text-sm text-red-700">Maximum wage must be at least the minimum wage.</p> : null}
                <div>
                  <label htmlFor="persona-store-location" className="text-sm font-semibold text-[var(--cocoa-800)]">Store location</label>
                  <div className="relative mt-2">
                    <MapPin className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--cocoa-500)]" aria-hidden="true" />
                    <input id="persona-store-location" value={formData.storeLocation} onChange={event => setFormData(previous => ({ ...previous, storeLocation: event.target.value }))} className="min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--cocoa-200)] bg-white pl-10 pr-4 text-sm text-[var(--cocoa-800)]" />
                  </div>
                </div>
              </section>
            ) : (
              <section role="tabpanel" aria-label={activeTab === 'dealbreakers' ? 'Dealbreakers' : 'Nice-to-haves'}>
                <h3 className="font-display text-xl font-semibold text-[var(--cocoa-900)]">{activeTab === 'dealbreakers' ? 'Must pass to advance' : 'Skills that earn extra consideration'}</h3>
                <p className="mt-1 text-sm leading-6 text-[var(--cocoa-600)]">Toggle the criteria used for {role.title} applicants.</p>
                <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label={activeTab === 'dealbreakers' ? 'Configured dealbreakers' : 'Configured nice-to-haves'}>
                  {(activeTab === 'dealbreakers' ? [...new Set([...role.dealbreakers, ...formData.dealbreakers])] : [...new Set([...roleNiceToHaves, ...formData.niceToHaves])]).map(item => {
                    const field = activeTab === 'dealbreakers' ? 'dealbreakers' : 'niceToHaves';
                    const selected = formData[field].includes(item);
                    return (
                      <button key={item} type="button" aria-pressed={selected} onClick={() => toggleValue(field, item)} className={`min-h-11 rounded-[var(--radius-md)] border px-3 text-sm font-medium transition-colors ${selected ? 'border-[var(--cocoa-700)] bg-[var(--cocoa-700)] text-white' : 'border-[var(--cocoa-200)] bg-[var(--cocoa-50)] text-[var(--cocoa-600)] hover:bg-[var(--cocoa-100)]'}`}>
                        {selected ? <Check className="mr-1 inline size-4" aria-hidden="true" /> : null}{item}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-6 flex gap-2">
                  <label htmlFor="persona-custom-criterion" className="sr-only">Add custom criterion</label>
                  <input id="persona-custom-criterion" value={customValue} onChange={event => setCustomValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addCustom(); } }} placeholder="Add your own…" className="min-h-11 min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--cocoa-200)] px-4 text-sm text-[var(--cocoa-800)]" />
                  <button type="button" onClick={addCustom} className="flex min-h-11 items-center gap-1 rounded-[var(--radius-md)] border border-[var(--cocoa-300)] px-3 text-sm font-semibold text-[var(--cocoa-700)] hover:bg-[var(--cocoa-100)]"><Plus className="size-4" aria-hidden="true" /> Add</button>
                </div>
              </section>
            )}

            <button type="submit" disabled={wageError} className="mt-8 flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--cocoa-700)] px-5 font-display text-base font-semibold text-white hover:bg-[var(--cocoa-600)] disabled:cursor-not-allowed disabled:opacity-50">
              <Save className="size-4" aria-hidden="true" /> Save Changes
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
