"use client";

import React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

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
    jobRole?: string;
}

const EXPERIENCE_LEVELS = [
    { id: '0-1', label: 'Less than 1 year', emoji: '🌱' },
    { id: '1-3', label: '1-3 years', emoji: '🌿' },
    { id: '3-5', label: '3-5 years', emoji: '🌳' },
    { id: '5+', label: '5+ years', emoji: '🏆' },
];

// Skills vary by role - this is for food service/retail
const SKILLS = [
    { id: 'customer_service', label: '😊 Customer Service' },
    { id: 'pos_register', label: '💳 POS/Register' },
    { id: 'espresso_machine', label: '☕ Espresso Machine' },
    { id: 'latte_art', label: '🎨 Latte Art' },
    { id: 'food_prep', label: '🍳 Food Preparation' },
    { id: 'inventory', label: '📦 Inventory Management' },
    { id: 'cleaning', label: '🧹 Cleaning/Sanitation' },
    { id: 'cash_handling', label: '💵 Cash Handling' },
    { id: 'opening_closing', label: '🔑 Opening/Closing' },
    { id: 'training', label: '👥 Training Others' },
];

const CERTIFICATIONS = [
    { id: 'food_handler', label: "🍽️ Food Handler's Permit" },
    { id: 'servsafe', label: '✅ ServSafe Certified' },
    { id: 'barista_cert', label: '☕ Barista Certification' },
    { id: 'first_aid', label: '🩹 First Aid/CPR' },
    { id: 'tips', label: '🍺 TIPS Alcohol Training' },
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

export function SkillsExperience({ data, onChange, onNext, onBack }: SkillsExperienceProps) {
    const toggleItem = (field: 'skills' | 'certifications' | 'languages', itemId: string) => {
        const current = data[field];
        const updated = current.includes(itemId)
            ? current.filter(i => i !== itemId)
            : [...current, itemId];
        onChange({ ...data, [field]: updated });
    };

    const isValid = data.yearsExperience && data.skills.length > 0;

    return (
        <div className="py-4 space-y-6">
            {/* Experience Level */}
            <div>
                <h3 className="text-base font-semibold text-stone-800 mb-3">
                    How much relevant work experience do you have?
                </h3>
                <div className="grid grid-cols-2 gap-2">
                    {EXPERIENCE_LEVELS.map(level => (
                        <button
                            key={level.id}
                            onClick={() => onChange({ ...data, yearsExperience: level.id })}
                            className={`p-3 rounded-xl text-left text-sm font-medium transition-all ${data.yearsExperience === level.id
                                    ? 'bg-lime-100 text-lime-800 border-2 border-lime-500'
                                    : 'bg-stone-50 text-stone-600 border-2 border-stone-200 hover:border-stone-300'
                                }`}
                        >
                            <span className="text-lg mr-1">{level.emoji}</span> {level.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Skills */}
            <div>
                <h3 className="text-base font-semibold text-stone-800 mb-2">
                    What skills do you have? <span className="text-stone-400 font-normal">(select all that apply)</span>
                </h3>
                <p className="text-xs text-stone-400 mb-3">Even if you're still learning!</p>
                <div className="flex flex-wrap gap-2">
                    {SKILLS.map(skill => (
                        <Badge
                            key={skill.id}
                            onClick={() => toggleItem('skills', skill.id)}
                            className={`cursor-pointer px-3 py-2 text-xs font-medium transition-all ${data.skills.includes(skill.id)
                                    ? 'bg-lime-500 text-white hover:bg-lime-600'
                                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                                }`}
                        >
                            {skill.label}
                        </Badge>
                    ))}
                </div>
            </div>

            {/* Certifications */}
            <div>
                <h3 className="text-base font-semibold text-stone-800 mb-2">
                    Any certifications? <span className="text-stone-400 font-normal">(optional)</span>
                </h3>
                <div className="flex flex-wrap gap-2">
                    {CERTIFICATIONS.map(cert => (
                        <Badge
                            key={cert.id}
                            onClick={() => toggleItem('certifications', cert.id)}
                            className={`cursor-pointer px-3 py-2 text-xs font-medium transition-all ${data.certifications.includes(cert.id)
                                    ? 'bg-amber-400 text-white hover:bg-amber-500'
                                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                                }`}
                        >
                            {cert.label}
                        </Badge>
                    ))}
                </div>
            </div>

            {/* Languages */}
            <div>
                <h3 className="text-base font-semibold text-stone-800 mb-3">
                    Languages you speak fluently
                </h3>
                <div className="flex flex-wrap gap-2">
                    {LANGUAGES.map(lang => (
                        <Badge
                            key={lang.id}
                            onClick={() => toggleItem('languages', lang.id)}
                            className={`cursor-pointer px-3 py-2 text-xs font-medium transition-all ${data.languages.includes(lang.id)
                                    ? 'bg-blue-500 text-white hover:bg-blue-600'
                                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                                }`}
                        >
                            {lang.label}
                        </Badge>
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

export type { SkillsData };
