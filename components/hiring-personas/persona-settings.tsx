"use client";

import React, { useRef, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from '@/components/ui/dialog';
import { getRoleOrDefault, type CafeRole } from '@/lib/domain/roles';

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

export function PersonaSettings({ persona, onSave, onClose, roleId, returnFocusRef }: PersonaSettingsProps) {
    const role: CafeRole = getRoleOrDefault(roleId);
    const jobTitleRef = useRef<HTMLInputElement>(null);

    // Populate dealbreakers and nice-to-haves from the role config
    const roleDealbreakers = role.dealbreakers;
    const roleNiceToHaves = role.niceToHaveSkills.map(s => s.label.replace(/^. /, ''));

    const [formData, setFormData] = useState<HiringPersona>({
        ...persona,
        jobTitle: role.title,
        wageMin: role.wageRange.min,
        wageMax: role.wageRange.max,
        dealbreakers: role.dealbreakers,
        niceToHaves: roleNiceToHaves,
    });
    const [newDealbreaker, setNewDealbreaker] = useState('');
    const [newNiceToHave, setNewNiceToHave] = useState('');

    const toggleDealbreaker = (item: string) => {
        setFormData(prev => ({
            ...prev,
            dealbreakers: prev.dealbreakers.includes(item)
                ? prev.dealbreakers.filter(d => d !== item)
                : [...prev.dealbreakers, item]
        }));
    };

    const toggleNiceToHave = (item: string) => {
        setFormData(prev => ({
            ...prev,
            niceToHaves: prev.niceToHaves.includes(item)
                ? prev.niceToHaves.filter(n => n !== item)
                : [...prev.niceToHaves, item]
        }));
    };

    const addCustomDealbreaker = () => {
        if (newDealbreaker.trim()) {
            setFormData(prev => ({
                ...prev,
                dealbreakers: [...prev.dealbreakers, newDealbreaker.trim()]
            }));
            setNewDealbreaker('');
        }
    };

    const addCustomNiceToHave = () => {
        if (newNiceToHave.trim()) {
            setFormData(prev => ({
                ...prev,
                niceToHaves: [...prev.niceToHaves, newNiceToHave.trim()]
            }));
            setNewNiceToHave('');
        }
    };

    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent
                className="max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl"
                onOpenAutoFocus={event => {
                    event.preventDefault();
                    jobTitleRef.current?.focus();
                }}
                onCloseAutoFocus={event => {
                    if (!returnFocusRef?.current) return;
                    event.preventDefault();
                    returnFocusRef.current.focus();
                }}
            >
            <Card className="bg-white border-stone-200 shadow-xl w-full rounded-2xl">
                <CardHeader className="border-b border-stone-100">
                    <div className="flex items-center justify-between gap-4 text-stone-800">
                        <DialogTitle className="text-base sm:text-lg">
                            ⚙️ Hiring Persona — {role.emoji} {role.title}
                        </DialogTitle>
                        <DialogClose asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                aria-label="Close hiring persona settings"
                                className="min-h-11 min-w-11 shrink-0 text-stone-500 hover:text-stone-700 hover:bg-stone-100 rounded-lg"
                            >
                                ✕
                            </Button>
                        </DialogClose>
                    </div>
                    <DialogDescription className="sr-only">
                        Edit the local demo role title, wage range, location, and configured criteria.
                    </DialogDescription>
                </CardHeader>
                <CardContent>
                  <form className="space-y-6 pt-6" onSubmit={event => { event.preventDefault(); onSave(formData); }}>
                    {/* Job Details */}
                    <div className="space-y-4">
                        <h3 className="text-sm font-medium text-stone-500 uppercase tracking-wide">Job Details</h3>

                        <div>
                            <label htmlFor="persona-job-title" className="block text-sm font-medium text-stone-700 mb-1.5">Job Title</label>
                            <input
                                ref={jobTitleRef}
                                id="persona-job-title"
                                type="text"
                                value={formData.jobTitle}
                                onChange={e => setFormData(prev => ({ ...prev, jobTitle: e.target.value }))}
                                className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-2.5 text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500"
                                placeholder="e.g., Barista"
                            />
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label htmlFor="persona-wage-min" className="block text-sm font-medium text-stone-700 mb-1.5">Min Wage ($/hr)</label>
                                <input
                                    id="persona-wage-min"
                                    type="number"
                                    value={formData.wageMin}
                                    onChange={e => setFormData(prev => ({ ...prev, wageMin: Number(e.target.value) }))}
                                    className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-2.5 text-stone-700 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500"
                                />
                            </div>
                            <div>
                                <label htmlFor="persona-wage-max" className="block text-sm font-medium text-stone-700 mb-1.5">Max Wage ($/hr)</label>
                                <input
                                    id="persona-wage-max"
                                    type="number"
                                    value={formData.wageMax}
                                    onChange={e => setFormData(prev => ({ ...prev, wageMax: Number(e.target.value) }))}
                                    className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-2.5 text-stone-700 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500"
                                />
                            </div>
                        </div>

                        <div>
                            <label htmlFor="persona-store-location" className="block text-sm font-medium text-stone-700 mb-1.5">Store Location</label>
                            <input
                                id="persona-store-location"
                                type="text"
                                value={formData.storeLocation}
                                onChange={e => setFormData(prev => ({ ...prev, storeLocation: e.target.value }))}
                                className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-2.5 text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500"
                                placeholder="e.g., Jersey City, NJ"
                            />
                        </div>
                    </div>

                    {/* Dealbreakers — sourced from role config */}
                    <div className="space-y-3">
                        <h3 className="text-sm font-medium text-stone-500 uppercase tracking-wide">
                            🚫 Dealbreakers (Must-Haves)
                        </h3>
                        <p className="text-xs text-stone-400">
                            Pre-filled from {role.emoji} {role.title} role. Toggle or add custom ones.
                        </p>
                        <div className="flex flex-wrap gap-2" role="group" aria-label="Configured dealbreakers">
                            {roleDealbreakers.map(item => (
                                <Badge
                                    asChild
                                    key={item}
                                    variant={formData.dealbreakers.includes(item) ? "default" : "outline"}
                                    className={`min-h-11 cursor-pointer rounded-lg px-3 py-1 transition-colors ${formData.dealbreakers.includes(item)
                                            ? 'bg-lime-500 text-white hover:bg-lime-600'
                                            : 'border-stone-200 text-stone-600 hover:bg-stone-100'
                                        }`}
                                >
                                    <button
                                        type="button"
                                        aria-pressed={formData.dealbreakers.includes(item)}
                                        onClick={() => toggleDealbreaker(item)}
                                    >
                                        {formData.dealbreakers.includes(item) ? '✓ ' : ''}{item}
                                    </button>
                                </Badge>
                            ))}
                            {/* Show any custom dealbreakers the user added */}
                            {formData.dealbreakers
                                .filter(d => !roleDealbreakers.includes(d))
                                .map(item => (
                                    <Badge
                                        asChild
                                        key={item}
                                        className="min-h-11 cursor-pointer rounded-lg px-3 py-1 bg-lime-500 text-white hover:bg-lime-600"
                                    >
                                        <button type="button" aria-pressed="true" onClick={() => toggleDealbreaker(item)}>
                                            ✓ {item} (custom)
                                        </button>
                                    </Badge>
                                ))}
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2">
                            <label htmlFor="persona-custom-dealbreaker" className="sr-only">Add a custom dealbreaker</label>
                            <input
                                id="persona-custom-dealbreaker"
                                type="text"
                                value={newDealbreaker}
                                onChange={e => setNewDealbreaker(e.target.value)}
                                className="flex-1 bg-stone-50 border border-stone-200 rounded-xl px-4 py-2 text-sm text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-lime-500/50"
                                placeholder="Add custom dealbreaker..."
                                onKeyDown={event => {
                                    if (event.key !== 'Enter') return;
                                    event.preventDefault();
                                    addCustomDealbreaker();
                                }}
                            />
                            <Button type="button" className="min-h-11 bg-stone-800 hover:bg-stone-900 text-white rounded-lg" onClick={addCustomDealbreaker}>Add dealbreaker</Button>
                        </div>
                    </div>

                    {/* Nice to Haves — sourced from role config */}
                    <div className="space-y-3">
                        <h3 className="text-sm font-medium text-stone-500 uppercase tracking-wide">
                            ⭐ Nice-to-Haves (Bonus Points)
                        </h3>
                        <div className="flex flex-wrap gap-2" role="group" aria-label="Configured nice-to-haves">
                            {roleNiceToHaves.map(item => (
                                <Badge
                                    asChild
                                    key={item}
                                    variant={formData.niceToHaves.includes(item) ? "default" : "outline"}
                                    className={`min-h-11 cursor-pointer rounded-lg px-3 py-1 transition-colors ${formData.niceToHaves.includes(item)
                                            ? 'bg-amber-400 text-white hover:bg-amber-500'
                                            : 'border-stone-200 text-stone-600 hover:bg-stone-100'
                                        }`}
                                >
                                    <button
                                        type="button"
                                        aria-pressed={formData.niceToHaves.includes(item)}
                                        onClick={() => toggleNiceToHave(item)}
                                    >
                                        {formData.niceToHaves.includes(item) ? '✓ ' : ''}{item}
                                    </button>
                                </Badge>
                            ))}
                            {formData.niceToHaves
                                .filter(n => !roleNiceToHaves.includes(n))
                                .map(item => (
                                    <Badge
                                        asChild
                                        key={item}
                                        className="min-h-11 cursor-pointer rounded-lg px-3 py-1 bg-amber-400 text-white hover:bg-amber-500"
                                    >
                                        <button type="button" aria-pressed="true" onClick={() => toggleNiceToHave(item)}>
                                            ✓ {item} (custom)
                                        </button>
                                    </Badge>
                                ))}
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2">
                            <label htmlFor="persona-custom-nice-to-have" className="sr-only">Add a custom nice-to-have</label>
                            <input
                                id="persona-custom-nice-to-have"
                                type="text"
                                value={newNiceToHave}
                                onChange={e => setNewNiceToHave(e.target.value)}
                                className="flex-1 bg-stone-50 border border-stone-200 rounded-xl px-4 py-2 text-sm text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-lime-500/50"
                                placeholder="Add custom nice-to-have..."
                                onKeyDown={event => {
                                    if (event.key !== 'Enter') return;
                                    event.preventDefault();
                                    addCustomNiceToHave();
                                }}
                            />
                            <Button type="button" className="min-h-11 bg-stone-800 hover:bg-stone-900 text-white rounded-lg" onClick={addCustomNiceToHave}>Add nice-to-have</Button>
                        </div>
                    </div>

                    {/* Save Button */}
                    <div className="flex justify-end gap-3 pt-4 border-t border-stone-100">
                        <DialogClose asChild>
                            <Button type="button" variant="outline" className="min-h-11 border-stone-200 text-stone-600 hover:bg-stone-50 rounded-xl px-5">Cancel</Button>
                        </DialogClose>
                        <Button type="submit" className="min-h-11 bg-lime-500 hover:bg-lime-600 text-white rounded-xl px-5 font-medium">Save Persona</Button>
                    </div>
                  </form>
                </CardContent>
            </Card>
            </DialogContent>
        </Dialog>
    );
}
