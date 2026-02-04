"use client";

import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

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
}

const COMMON_DEALBREAKERS = [
    "Weekend availability required",
    "Must be 18+",
    "Valid work authorization",
    "Food Handler's Permit",
    "Reliable transportation",
    "Available for closing shifts",
    "Minimum 20 hrs/week",
];

const COMMON_NICE_TO_HAVES = [
    "Previous barista experience",
    "Latte art skills",
    "Customer service experience",
    "POS/Register experience",
    "Bilingual",
    "Management experience",
];

export function PersonaSettings({ persona, onSave, onClose }: PersonaSettingsProps) {
    const [formData, setFormData] = useState<HiringPersona>(persona);
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
        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <Card className="bg-white border-stone-200 shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl">
                <CardHeader className="border-b border-stone-100">
                    <CardTitle className="flex items-center justify-between text-stone-800">
                        <span>⚙️ Hiring Persona Settings</span>
                        <Button variant="ghost" size="sm" onClick={onClose} className="text-stone-400 hover:text-stone-600 hover:bg-stone-100 rounded-lg">✕</Button>
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6 pt-6">
                    {/* Job Details */}
                    <div className="space-y-4">
                        <h3 className="text-sm font-medium text-stone-500 uppercase tracking-wide">Job Details</h3>

                        <div>
                            <label className="block text-sm font-medium text-stone-700 mb-1.5">Job Title</label>
                            <input
                                type="text"
                                value={formData.jobTitle}
                                onChange={e => setFormData(prev => ({ ...prev, jobTitle: e.target.value }))}
                                className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-2.5 text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500"
                                placeholder="e.g., Barista"
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-stone-700 mb-1.5">Min Wage ($/hr)</label>
                                <input
                                    type="number"
                                    value={formData.wageMin}
                                    onChange={e => setFormData(prev => ({ ...prev, wageMin: Number(e.target.value) }))}
                                    className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-2.5 text-stone-700 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-stone-700 mb-1.5">Max Wage ($/hr)</label>
                                <input
                                    type="number"
                                    value={formData.wageMax}
                                    onChange={e => setFormData(prev => ({ ...prev, wageMax: Number(e.target.value) }))}
                                    className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-2.5 text-stone-700 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-stone-700 mb-1.5">Store Location</label>
                            <input
                                type="text"
                                value={formData.storeLocation}
                                onChange={e => setFormData(prev => ({ ...prev, storeLocation: e.target.value }))}
                                className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-2.5 text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500"
                                placeholder="e.g., Jersey City, NJ"
                            />
                        </div>
                    </div>

                    {/* Dealbreakers */}
                    <div className="space-y-3">
                        <h3 className="text-sm font-medium text-stone-500 uppercase tracking-wide">
                            🚫 Dealbreakers (Must-Haves)
                        </h3>
                        <p className="text-xs text-stone-400">
                            Candidates failing these will be automatically filtered out.
                        </p>
                        <div className="flex flex-wrap gap-2">
                            {COMMON_DEALBREAKERS.map(item => (
                                <Badge
                                    key={item}
                                    variant={formData.dealbreakers.includes(item) ? "default" : "outline"}
                                    className={`cursor-pointer rounded-lg px-3 py-1 transition-colors ${formData.dealbreakers.includes(item)
                                            ? 'bg-lime-500 text-white hover:bg-lime-600'
                                            : 'border-stone-200 text-stone-600 hover:bg-stone-100'
                                        }`}
                                    onClick={() => toggleDealbreaker(item)}
                                >
                                    {formData.dealbreakers.includes(item) ? '✓ ' : ''}{item}
                                </Badge>
                            ))}
                        </div>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={newDealbreaker}
                                onChange={e => setNewDealbreaker(e.target.value)}
                                className="flex-1 bg-stone-50 border border-stone-200 rounded-xl px-4 py-2 text-sm text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-lime-500/50"
                                placeholder="Add custom dealbreaker..."
                                onKeyDown={e => e.key === 'Enter' && addCustomDealbreaker()}
                            />
                            <Button size="sm" className="bg-stone-800 hover:bg-stone-900 text-white rounded-lg" onClick={addCustomDealbreaker}>Add</Button>
                        </div>
                    </div>

                    {/* Nice to Haves */}
                    <div className="space-y-3">
                        <h3 className="text-sm font-medium text-stone-500 uppercase tracking-wide">
                            ⭐ Nice-to-Haves (Bonus Points)
                        </h3>
                        <div className="flex flex-wrap gap-2">
                            {COMMON_NICE_TO_HAVES.map(item => (
                                <Badge
                                    key={item}
                                    variant={formData.niceToHaves.includes(item) ? "default" : "outline"}
                                    className={`cursor-pointer rounded-lg px-3 py-1 transition-colors ${formData.niceToHaves.includes(item)
                                            ? 'bg-amber-400 text-white hover:bg-amber-500'
                                            : 'border-stone-200 text-stone-600 hover:bg-stone-100'
                                        }`}
                                    onClick={() => toggleNiceToHave(item)}
                                >
                                    {formData.niceToHaves.includes(item) ? '✓ ' : ''}{item}
                                </Badge>
                            ))}
                        </div>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={newNiceToHave}
                                onChange={e => setNewNiceToHave(e.target.value)}
                                className="flex-1 bg-stone-50 border border-stone-200 rounded-xl px-4 py-2 text-sm text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-lime-500/50"
                                placeholder="Add custom nice-to-have..."
                                onKeyDown={e => e.key === 'Enter' && addCustomNiceToHave()}
                            />
                            <Button size="sm" className="bg-stone-800 hover:bg-stone-900 text-white rounded-lg" onClick={addCustomNiceToHave}>Add</Button>
                        </div>
                    </div>

                    {/* Save Button */}
                    <div className="flex justify-end gap-3 pt-4 border-t border-stone-100">
                        <Button variant="outline" className="border-stone-200 text-stone-600 hover:bg-stone-50 rounded-xl px-5" onClick={onClose}>Cancel</Button>
                        <Button className="bg-lime-500 hover:bg-lime-600 text-white rounded-xl px-5 font-medium" onClick={() => onSave(formData)}>Save Persona</Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
