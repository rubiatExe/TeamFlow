"use client";

import React from 'react';
import { Button } from '@/components/ui/button';

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

const choiceClass = (selected: boolean) => `min-h-11 p-3 rounded-xl text-left text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 ${selected
    ? 'bg-lime-100 text-lime-900 border-2 border-lime-600'
    : 'bg-stone-50 text-stone-700 border-2 border-stone-300 hover:border-stone-500'
    }`;

export function CandidateProfile({ data, onChange, onNext, onBack }: CandidateProfileProps) {
    const toggleArrayValue = (field: 'preferredShifts' | 'daysAvailable', value: string) => {
        const current = data[field];
        onChange({
            ...data,
            [field]: current.includes(value)
                ? current.filter(item => item !== value)
                : [...current, value],
        });
    };

    const isValid = data.preferredShifts.length > 0
        && data.daysAvailable.length > 0
        && data.transportation
        && data.contactPreference;

    return (
        <div className="py-4 space-y-6">
            <fieldset>
                <legend className="mb-3 text-base font-semibold text-stone-800">
                    What shifts work best for you? <span className="text-stone-500 font-normal">(select all that apply)</span>
                </legend>
                <div className="grid grid-cols-1 gap-2 min-[390px]:grid-cols-2">
                    {SHIFTS.map(shift => {
                        const selected = data.preferredShifts.includes(shift.id);
                        return (
                            <button
                                key={shift.id}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => toggleArrayValue('preferredShifts', shift.id)}
                                className={choiceClass(selected)}
                            >
                                {shift.label}
                            </button>
                        );
                    })}
                </div>
            </fieldset>

            <fieldset>
                <legend className="mb-3 text-base font-semibold text-stone-800">Which days are you available?</legend>
                <div className="flex flex-wrap gap-2">
                    {DAYS.map(day => {
                        const selected = data.daysAvailable.includes(day);
                        return (
                            <button
                                key={day}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => toggleArrayValue('daysAvailable', day)}
                                className={`min-h-11 min-w-11 rounded-lg px-3 py-2 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 ${selected
                                    ? 'bg-lime-600 text-white hover:bg-lime-700'
                                    : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
                                    }`}
                            >
                                <span className="min-[390px]:hidden">{day.slice(0, 3)}</span>
                                <span className="hidden min-[390px]:inline">{day}</span>
                            </button>
                        );
                    })}
                </div>
            </fieldset>

            <div>
                <label htmlFor="candidate-start-date" className="mb-3 block text-base font-semibold text-stone-800">
                    When can you start? <span className="text-stone-500 font-normal">(optional)</span>
                </label>
                <input
                    id="candidate-start-date"
                    name="startDate"
                    type="date"
                    value={data.startDate}
                    onChange={(event) => onChange({ ...data, startDate: event.target.value })}
                    className="w-full min-w-0 bg-stone-50 border border-stone-300 rounded-xl px-4 py-3 text-stone-800 focus:outline-none focus:ring-2 focus:ring-lime-600 focus:border-lime-600"
                />
            </div>

            <fieldset>
                <legend className="mb-3 text-base font-semibold text-stone-800">How will you get to work?</legend>
                <div className="grid grid-cols-1 gap-2 min-[390px]:grid-cols-2">
                    {TRANSPORT.map(option => {
                        const selected = data.transportation === option.id;
                        return (
                            <button
                                key={option.id}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => onChange({ ...data, transportation: option.id })}
                                className={choiceClass(selected)}
                            >
                                {option.label}
                            </button>
                        );
                    })}
                </div>
            </fieldset>

            <fieldset>
                <legend className="mb-3 text-base font-semibold text-stone-800">Best way to reach you?</legend>
                <div className="grid grid-cols-1 gap-2 min-[390px]:grid-cols-3">
                    {CONTACT_PREFS.map(preference => {
                        const selected = data.contactPreference === preference.id;
                        return (
                            <button
                                key={preference.id}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => onChange({ ...data, contactPreference: preference.id })}
                                className={`${choiceClass(selected)} text-center`}
                            >
                                {preference.label}
                            </button>
                        );
                    })}
                </div>
            </fieldset>

            <div className="flex flex-wrap gap-3 pt-4">
                <Button type="button" variant="outline" onClick={onBack} className="min-h-11 border-stone-300 text-stone-700 hover:bg-stone-50 rounded-xl">
                    ← Back
                </Button>
                <Button type="button" onClick={onNext} disabled={!isValid} className="min-h-11 min-w-36 flex-1 bg-lime-600 hover:bg-lime-700 text-white rounded-xl font-medium disabled:opacity-50">
                    Continue →
                </Button>
            </div>
        </div>
    );
}

export type { ProfileData };
