"use client";

import React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface ProfileData {
    preferredShifts: string[];
    daysAvailable: string[];
    startDate: string;
    transportation: string;
    contactPreference: string;
}

interface CandidateProfileProps {
    data: ProfileData;
    onChange: (data: ProfileData) => void;
    onNext: () => void;
    onBack: () => void;
}

const SHIFTS = [
    { id: 'morning', label: '🌅 Morning (6am-12pm)' },
    { id: 'afternoon', label: '☀️ Afternoon (12pm-5pm)' },
    { id: 'evening', label: '🌆 Evening (5pm-10pm)' },
    { id: 'overnight', label: '🌙 Overnight (10pm-6am)' },
];

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const TRANSPORT = [
    { id: 'car', label: '🚗 Personal car' },
    { id: 'public', label: '🚇 Public transit' },
    { id: 'bike', label: '🚴 Bike' },
    { id: 'walk', label: '🚶 Walking' },
    { id: 'rideshare', label: '🚕 Rideshare' },
];

const CONTACT_PREFS = [
    { id: 'text', label: '💬 Text message' },
    { id: 'call', label: '📞 Phone call' },
    { id: 'email', label: '📧 Email' },
];

export function CandidateProfile({ data, onChange, onNext, onBack }: CandidateProfileProps) {
    const toggleShift = (shiftId: string) => {
        const newShifts = data.preferredShifts.includes(shiftId)
            ? data.preferredShifts.filter(s => s !== shiftId)
            : [...data.preferredShifts, shiftId];
        onChange({ ...data, preferredShifts: newShifts });
    };

    const toggleDay = (day: string) => {
        const newDays = data.daysAvailable.includes(day)
            ? data.daysAvailable.filter(d => d !== day)
            : [...data.daysAvailable, day];
        onChange({ ...data, daysAvailable: newDays });
    };

    const isValid = data.preferredShifts.length > 0 &&
        data.daysAvailable.length > 0 &&
        data.transportation &&
        data.contactPreference;

    return (
        <div className="py-4 space-y-6">
            {/* Preferred Shifts */}
            <div>
                <h3 className="text-base font-semibold text-stone-800 mb-3">
                    What shifts work best for you? <span className="text-stone-400 font-normal">(select all that apply)</span>
                </h3>
                <div className="grid grid-cols-2 gap-2">
                    {SHIFTS.map(shift => (
                        <button
                            key={shift.id}
                            onClick={() => toggleShift(shift.id)}
                            className={`p-3 rounded-xl text-left text-sm font-medium transition-all ${data.preferredShifts.includes(shift.id)
                                    ? 'bg-lime-100 text-lime-800 border-2 border-lime-500'
                                    : 'bg-stone-50 text-stone-600 border-2 border-stone-200 hover:border-stone-300'
                                }`}
                        >
                            {shift.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Days Available */}
            <div>
                <h3 className="text-base font-semibold text-stone-800 mb-3">
                    Which days are you available?
                </h3>
                <div className="flex flex-wrap gap-2">
                    {DAYS.map(day => (
                        <Badge
                            key={day}
                            onClick={() => toggleDay(day)}
                            className={`cursor-pointer px-3 py-2 text-sm font-medium transition-all ${data.daysAvailable.includes(day)
                                    ? 'bg-lime-500 text-white hover:bg-lime-600'
                                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                                }`}
                        >
                            {day.slice(0, 3)}
                        </Badge>
                    ))}
                </div>
            </div>

            {/* Start Date */}
            <div>
                <h3 className="text-base font-semibold text-stone-800 mb-3">
                    When can you start?
                </h3>
                <input
                    type="date"
                    value={data.startDate}
                    onChange={(e) => onChange({ ...data, startDate: e.target.value })}
                    min={new Date().toISOString().split('T')[0]}
                    className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 text-stone-700 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500"
                />
            </div>

            {/* Transportation */}
            <div>
                <h3 className="text-base font-semibold text-stone-800 mb-3">
                    How will you get to work?
                </h3>
                <div className="grid grid-cols-2 gap-2">
                    {TRANSPORT.map(t => (
                        <button
                            key={t.id}
                            onClick={() => onChange({ ...data, transportation: t.id })}
                            className={`p-3 rounded-xl text-left text-sm font-medium transition-all ${data.transportation === t.id
                                    ? 'bg-lime-100 text-lime-800 border-2 border-lime-500'
                                    : 'bg-stone-50 text-stone-600 border-2 border-stone-200 hover:border-stone-300'
                                }`}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Contact Preference */}
            <div>
                <h3 className="text-base font-semibold text-stone-800 mb-3">
                    Best way to reach you?
                </h3>
                <div className="flex gap-2">
                    {CONTACT_PREFS.map(pref => (
                        <button
                            key={pref.id}
                            onClick={() => onChange({ ...data, contactPreference: pref.id })}
                            className={`flex-1 p-3 rounded-xl text-center text-sm font-medium transition-all ${data.contactPreference === pref.id
                                    ? 'bg-lime-100 text-lime-800 border-2 border-lime-500'
                                    : 'bg-stone-50 text-stone-600 border-2 border-stone-200 hover:border-stone-300'
                                }`}
                        >
                            {pref.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Navigation */}
            <div className="flex gap-3 pt-4">
                <Button
                    variant="outline"
                    onClick={onBack}
                    className="border-stone-200 text-stone-600 hover:bg-stone-50 rounded-xl"
                >
                    ← Back
                </Button>
                <Button
                    onClick={onNext}
                    disabled={!isValid}
                    className="flex-1 bg-lime-500 hover:bg-lime-600 text-white rounded-xl font-medium disabled:opacity-50"
                >
                    Continue →
                </Button>
            </div>
        </div>
    );
}

export type { ProfileData };
