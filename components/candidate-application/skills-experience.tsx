"use client";

import React from 'react';
import { Button } from '@/components/ui/button';
import { getRoleOrDefault, type CafeRole } from '@/lib/domain/roles';

interface SkillsData {
    yearsExperience: string;
    skills: string[];
    certifications: string[];
    languages: string[];
}

interface SkillsExperienceProps {
    data: SkillsData;
    onChange: (data: SkillsData) => void;
    onNext: () => void;
    onBack: () => void;
    roleId?: string;
}

const EXPERIENCE_LEVELS = [
    { id: '0-1', label: 'Less than 1 year', emoji: '🌱' },
    { id: '1-3', label: '1-3 years', emoji: '🌿' },
    { id: '3-5', label: '3-5 years', emoji: '🌳' },
    { id: '5+', label: '5+ years', emoji: '🏆' },
];

const LANGUAGES = [
    { id: 'english', label: 'English' },
    { id: 'spanish', label: 'Spanish' },
    { id: 'mandarin', label: 'Mandarin' },
    { id: 'hindi', label: 'Hindi' },
    { id: 'french', label: 'French' },
    { id: 'korean', label: 'Korean' },
    { id: 'portuguese', label: 'Portuguese' },
    { id: 'arabic', label: 'Arabic' },
];

const chipClass = (selected: boolean, selectedClass = 'bg-lime-600 text-white hover:bg-lime-700') => `min-h-11 rounded-lg px-3 py-2 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 ${selected
    ? selectedClass
    : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
    }`;

export function SkillsExperience({ data, onChange, onNext, onBack, roleId }: SkillsExperienceProps) {
    const role: CafeRole = getRoleOrDefault(roleId);
    const roleSkills = [...role.essentialSkills, ...role.niceToHaveSkills];

    const toggleItem = (field: 'skills' | 'certifications' | 'languages', itemId: string) => {
        const current = data[field];
        onChange({
            ...data,
            [field]: current.includes(itemId)
                ? current.filter(item => item !== itemId)
                : [...current, itemId],
        });
    };

    const isValid = Boolean(data.yearsExperience) && data.skills.length > 0;

    return (
        <div className="py-4 space-y-6">
            <div className="flex items-center gap-2 px-3 py-2 bg-lime-50 border border-lime-300 rounded-xl">
                <span aria-hidden="true" className="text-xl">{role.emoji}</span>
                <span className="text-sm font-medium text-lime-900">Applying for: {role.title}</span>
            </div>

            <fieldset>
                <legend className="mb-3 text-base font-semibold text-stone-800">
                    How much relevant {role.title.toLowerCase()} experience do you have?
                </legend>
                <div className="grid grid-cols-1 gap-2 min-[390px]:grid-cols-2">
                    {EXPERIENCE_LEVELS.map(level => {
                        const selected = data.yearsExperience === level.id;
                        return (
                            <button
                                key={level.id}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => onChange({ ...data, yearsExperience: level.id })}
                                className={`min-h-12 p-3 rounded-xl text-left text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 ${selected
                                    ? 'bg-lime-100 text-lime-900 border-2 border-lime-600'
                                    : 'bg-stone-50 text-stone-700 border-2 border-stone-300 hover:border-stone-500'
                                    }`}
                            >
                                <span aria-hidden="true" className="text-lg mr-1">{level.emoji}</span> {level.label}
                            </button>
                        );
                    })}
                </div>
            </fieldset>

            <fieldset>
                <legend className="text-base font-semibold text-stone-800">
                    What skills do you have? <span className="text-stone-500 font-normal">(select all that apply)</span>
                </legend>
                <p className="mb-3 text-xs text-stone-500">Choose at least one, including skills you are still learning.</p>
                <div className="flex flex-wrap gap-2">
                    {roleSkills.map(skill => {
                        const selected = data.skills.includes(skill.id);
                        return (
                            <button
                                key={skill.id}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => toggleItem('skills', skill.id)}
                                className={chipClass(selected)}
                            >
                                {skill.label}
                            </button>
                        );
                    })}
                </div>
            </fieldset>

            <fieldset>
                <legend className="mb-2 text-base font-semibold text-stone-800">
                    Certifications <span className="text-stone-500 font-normal">(optional)</span>
                </legend>
                <div className="flex flex-wrap gap-2">
                    {role.certifications.map(certification => {
                        const selected = data.certifications.includes(certification.id);
                        return (
                            <button
                                key={certification.id}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => toggleItem('certifications', certification.id)}
                                className={chipClass(selected, 'bg-amber-500 text-stone-950 hover:bg-amber-600')}
                            >
                                {certification.label}
                            </button>
                        );
                    })}
                </div>
            </fieldset>

            <fieldset>
                <legend className="mb-3 text-base font-semibold text-stone-800">Languages you speak fluently</legend>
                <div className="flex flex-wrap gap-2">
                    {LANGUAGES.map(language => {
                        const selected = data.languages.includes(language.id);
                        return (
                            <button
                                key={language.id}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => toggleItem('languages', language.id)}
                                className={chipClass(selected, 'bg-blue-700 text-white hover:bg-blue-800')}
                            >
                                {language.label}
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

export type { SkillsData };
