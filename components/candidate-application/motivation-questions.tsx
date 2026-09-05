"use client";

import React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getRoleOrDefault, type CafeRole } from '@/lib/domain/roles';

interface MotivationData {
    whyWorkHere: string;
    superpower: string;
    aboveAndBeyond: string;
    skillAnswers: Record<string, string>; // role-specific skill question answers
}

interface MotivationQuestionsProps {
    data: MotivationData;
    onChange: (data: MotivationData) => void;
    onNext: () => void;
    onBack: () => void;
    merchantName?: string;
    roleId?: string;
}

export function MotivationQuestions({ data, onChange, onNext, onBack, merchantName = 'our team', roleId }: MotivationQuestionsProps) {
    const role: CafeRole = getRoleOrDefault(roleId);
    const superpowers = role.superpowers;
    const motivationQs = role.questions.motivation;
    const skillQs = role.questions.skills;

    // Primary motivation question (first one from role config)
    const primaryMotivation = motivationQs[0];
    // Secondary motivation question (optional, second one)
    const secondaryMotivation = motivationQs.length > 1 ? motivationQs[1] : null;

    const charCount = data.whyWorkHere.length;
    const minChars = primaryMotivation?.minChars || 50;
    const maxChars = primaryMotivation?.maxChars || 500;

    // Check validity: primary question + superpower required
    const isValid = data.whyWorkHere.length >= minChars && data.superpower;

    return (
        <div className="py-4 space-y-6">
            {/* Role context */}
            <div className="flex items-center gap-2 px-3 py-2 bg-lime-50 border border-lime-200 rounded-xl">
                <span className="text-xl">{role.emoji}</span>
                <span className="text-sm font-medium text-lime-800">
                    {role.title} — Final Questions
                </span>
            </div>

            {/* Why work here — role-specific */}
            <div>
                <label htmlFor="motivation-primary" className="block text-base font-semibold text-stone-800 mb-2">
                    {primaryMotivation?.question || `Why do you want to work at ${merchantName}?`}
                </label>
                <p id="motivation-primary-help" className="text-xs text-stone-500 mb-3">
                    Be yourself! We want to hear your voice.
                </p>
                <textarea
                    id="motivation-primary"
                    name="whyWorkHere"
                    aria-describedby="motivation-primary-help motivation-primary-count"
                    aria-required="true"
                    value={data.whyWorkHere}
                    onChange={(e) => onChange({ ...data, whyWorkHere: e.target.value })}
                    placeholder="I'm excited about this opportunity because..."
                    rows={4}
                    maxLength={maxChars}
                    className="w-full bg-stone-50 border border-stone-300 rounded-xl px-4 py-3 text-stone-800 placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-lime-600 focus:border-lime-600 resize-none"
                />
                <div className="flex justify-between mt-1">
                    <span id="motivation-primary-count" className={`text-xs ${charCount >= minChars ? 'text-lime-700' : 'text-stone-500'}`}>
                        {charCount >= minChars ? '✓ Great!' : `${minChars - charCount} more characters needed`}
                    </span>
                    <span className="text-xs text-stone-500">{charCount}/{maxChars}</span>
                </div>
            </div>

            {/* Role-Specific Skill Question (scenario-based) */}
            {skillQs.filter(q => q.type === 'text').slice(0, 1).map(q => (
                <div key={q.id}>
                    <label htmlFor={`motivation-skill-${q.id}`} className="block text-base font-semibold text-stone-800 mb-2">
                        {q.question} 💭
                    </label>
                    <p id={`motivation-skill-${q.id}-help`} className="text-xs text-stone-500 mb-3">
                        Walk us through your thinking — there&apos;s no wrong answer.
                    </p>
                    <textarea
                        id={`motivation-skill-${q.id}`}
                        name={`skillAnswer-${q.id}`}
                        aria-describedby={`motivation-skill-${q.id}-help motivation-skill-${q.id}-count`}
                        value={data.skillAnswers?.[q.id] || ''}
                        onChange={(e) => onChange({
                            ...data,
                            skillAnswers: { ...data.skillAnswers, [q.id]: e.target.value }
                        })}
                        placeholder="Here's what I would do..."
                        rows={3}
                        maxLength={q.maxChars || 400}
                        className="w-full bg-stone-50 border border-stone-300 rounded-xl px-4 py-3 text-stone-800 placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-lime-600 focus:border-lime-600 resize-none"
                    />
                    <div className="text-right mt-1">
                        <span id={`motivation-skill-${q.id}-count`} className="text-xs text-stone-500">{(data.skillAnswers?.[q.id] || '').length}/{q.maxChars || 400}</span>
                    </div>
                </div>
            ))}

            {/* Superpower — role-specific */}
            <fieldset>
                <legend className="text-base font-semibold text-stone-800 mb-2">
                    What&apos;s your superpower as a {role.title.toLowerCase()}? 🦸
                </legend>
                <p className="text-xs text-stone-500 mb-3">Pick the one that fits you best</p>
                <div className="space-y-2">
                    {superpowers.map(power => (
                        <button
                            key={power.id}
                            type="button"
                            aria-pressed={data.superpower === power.id}
                            onClick={() => onChange({ ...data, superpower: power.id })}
                            className={`w-full min-h-11 p-3 rounded-xl text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 ${data.superpower === power.id
                                ? 'bg-lime-100 border-2 border-lime-600'
                                : 'bg-stone-50 border-2 border-stone-300 hover:border-stone-500'
                                }`}
                        >
                            <div className="flex items-center gap-3">
                                <span className="text-lg">{power.emoji}</span>
                                <div>
                                    <p className={`font-medium text-sm ${data.superpower === power.id ? 'text-lime-800' : 'text-stone-700'}`}>
                                        {power.label}
                                    </p>
                                    <p className={`text-xs ${data.superpower === power.id ? 'text-lime-800' : 'text-stone-600'}`}>
                                        {power.desc}
                                    </p>
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            </fieldset>

            {/* Above and beyond story — role-specific (optional) */}
            <div>
                <label htmlFor="motivation-secondary" className="block text-base font-semibold text-stone-800 mb-2">
                    {secondaryMotivation?.question || 'Share a time you went above and beyond'}
                    <Badge className="ml-2 bg-stone-100 text-stone-500 font-normal">Optional</Badge>
                </label>
                <p id="motivation-secondary-help" className="text-xs text-stone-500 mb-3">
                    A quick story that shows who you are
                </p>
                <textarea
                    id="motivation-secondary"
                    name="aboveAndBeyond"
                    aria-describedby="motivation-secondary-help motivation-secondary-count"
                    value={data.aboveAndBeyond}
                    onChange={(e) => onChange({ ...data, aboveAndBeyond: e.target.value })}
                    placeholder="One time at my previous job..."
                    rows={3}
                    maxLength={secondaryMotivation?.maxChars || 400}
                    className="w-full bg-stone-50 border border-stone-300 rounded-xl px-4 py-3 text-stone-800 placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-lime-600 focus:border-lime-600 resize-none"
                />
                <div className="text-right mt-1">
                    <span id="motivation-secondary-count" className="text-xs text-stone-500">{data.aboveAndBeyond.length}/{secondaryMotivation?.maxChars || 400}</span>
                </div>
            </div>

            {/* Navigation */}
            <div className="flex flex-wrap gap-3 pt-4">
                <Button
                    type="button"
                    variant="outline"
                    onClick={onBack}
                    className="min-h-11 border-stone-300 text-stone-700 hover:bg-stone-50 rounded-xl"
                >
                    ← Back
                </Button>
                <Button
                    type="button"
                    onClick={onNext}
                    disabled={!isValid}
                    className="min-h-11 min-w-36 flex-1 bg-lime-600 hover:bg-lime-700 text-white rounded-xl font-medium disabled:opacity-50"
                >
                    Almost Done! →
                </Button>
            </div>
        </div>
    );
}

export type { MotivationData };
