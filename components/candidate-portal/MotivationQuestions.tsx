"use client";

import React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface MotivationData {
    whyWorkHere: string;
    superpower: string;
    aboveAndBeyond: string;
}

interface MotivationQuestionsProps {
    data: MotivationData;
    onChange: (data: MotivationData) => void;
    onNext: () => void;
    onBack: () => void;
    merchantName?: string;
}

const SUPERPOWERS = [
    { id: 'friendly', label: '😊 People person', desc: 'I make everyone feel welcome' },
    { id: 'fast', label: '⚡ Speed demon', desc: 'I work fast without sacrificing quality' },
    { id: 'calm', label: '🧘 Cool under pressure', desc: 'Rush hour? No problem' },
    { id: 'detail', label: '🔍 Detail-oriented', desc: 'I never miss a thing' },
    { id: 'learner', label: '📚 Quick learner', desc: 'Show me once and I get it' },
    { id: 'leader', label: '👑 Natural leader', desc: 'People look to me for guidance' },
];

export function MotivationQuestions({ data, onChange, onNext, onBack, merchantName = 'our team' }: MotivationQuestionsProps) {
    const isValid = data.whyWorkHere.length >= 50 && data.superpower;

    const charCount = data.whyWorkHere.length;
    const minChars = 50;

    return (
        <div className="py-4 space-y-6">
            {/* Why work here */}
            <div>
                <h3 className="text-base font-semibold text-stone-800 mb-2">
                    Why do you want to work at {merchantName}?
                </h3>
                <p className="text-xs text-stone-400 mb-3">
                    Be yourself! We want to hear your voice.
                </p>
                <textarea
                    value={data.whyWorkHere}
                    onChange={(e) => onChange({ ...data, whyWorkHere: e.target.value })}
                    placeholder="I'm excited about this opportunity because..."
                    rows={4}
                    maxLength={500}
                    className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500 resize-none"
                />
                <div className="flex justify-between mt-1">
                    <span className={`text-xs ${charCount >= minChars ? 'text-lime-600' : 'text-stone-400'}`}>
                        {charCount >= minChars ? '✓ Great!' : `${minChars - charCount} more characters needed`}
                    </span>
                    <span className="text-xs text-stone-400">{charCount}/500</span>
                </div>
            </div>

            {/* Superpower */}
            <div>
                <h3 className="text-base font-semibold text-stone-800 mb-2">
                    What's your superpower at work? 🦸
                </h3>
                <p className="text-xs text-stone-400 mb-3">Pick the one that fits you best</p>
                <div className="space-y-2">
                    {SUPERPOWERS.map(power => (
                        <button
                            key={power.id}
                            onClick={() => onChange({ ...data, superpower: power.id })}
                            className={`w-full p-3 rounded-xl text-left transition-all ${data.superpower === power.id
                                ? 'bg-lime-100 border-2 border-lime-500'
                                : 'bg-stone-50 border-2 border-stone-200 hover:border-stone-300'
                                }`}
                        >
                            <div className="flex items-center gap-3">
                                <span className="text-lg">{power.label.split(' ')[0]}</span>
                                <div>
                                    <p className={`font-medium text-sm ${data.superpower === power.id ? 'text-lime-800' : 'text-stone-700'}`}>
                                        {power.label.split(' ').slice(1).join(' ')}
                                    </p>
                                    <p className={`text-xs ${data.superpower === power.id ? 'text-lime-600' : 'text-stone-400'}`}>
                                        {power.desc}
                                    </p>
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            </div>

            {/* Above and beyond story (optional) */}
            <div>
                <h3 className="text-base font-semibold text-stone-800 mb-2">
                    Share a time you went above and beyond
                    <Badge className="ml-2 bg-stone-100 text-stone-500 font-normal">Optional</Badge>
                </h3>
                <p className="text-xs text-stone-400 mb-3">
                    A quick story that shows who you are
                </p>
                <textarea
                    value={data.aboveAndBeyond}
                    onChange={(e) => onChange({ ...data, aboveAndBeyond: e.target.value })}
                    placeholder="One time at my previous job..."
                    rows={3}
                    maxLength={400}
                    className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-lime-500/50 focus:border-lime-500 resize-none"
                />
                <div className="text-right mt-1">
                    <span className="text-xs text-stone-400">{data.aboveAndBeyond.length}/400</span>
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
                    Almost Done! →
                </Button>
            </div>
        </div>
    );
}

export type { MotivationData };
