"use client";

import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { ParserOutput } from '@/app/api/types';

interface CandidateCardProps {
    candidateId?: string;
    data: ParserOutput;
    status?: 'new' | 'invited' | 'interviewed' | 'hired';
    onInvite?: (candidateId: string) => void;
}

const statusColors: Record<string, string> = {
    new: 'bg-blue-100 text-blue-700',
    invited: 'bg-amber-100 text-amber-700',
    interviewed: 'bg-purple-100 text-purple-700',
    hired: 'bg-lime-100 text-lime-700',
};

export function CandidateCard({ candidateId, data, status = 'new', onInvite }: CandidateCardProps) {
    const { candidate, score, red_flags } = data;
    const [inviting, setInviting] = useState(false);

    const handleInvite = async () => {
        if (!candidateId) return;
        setInviting(true);
        try {
            const res = await fetch('/api/invite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    candidateId,
                    candidateName: candidate.name,
                    candidateEmail: candidate.email,
                    candidatePhone: candidate.phone,
                    storeName: "Joe's Coffee",
                }),
            });
            const data = await res.json();
            console.log('[Invite Result]', data);
            if (onInvite) onInvite(candidateId);
        } catch (err) {
            console.error('[Invite Error]', err);
        } finally {
            setInviting(false);
        }
    };

    const getScoreColor = (total: number) => {
        if (total >= 80) return 'text-lime-600';
        if (total >= 50) return 'text-amber-600';
        return 'text-red-600';
    };

    return (
        <Card className="bg-white border border-stone-200 hover:border-stone-300 transition-all duration-200 shadow-sm hover:shadow-md rounded-2xl">
            <CardHeader className="pb-3 pt-5 px-5">
                <div className="flex justify-between items-start gap-2">
                    <CardTitle className="text-lg font-semibold text-stone-800 leading-tight">
                        {candidate.name}
                    </CardTitle>
                    <Badge className={`${statusColors[status]} text-xs font-medium px-3 py-1 rounded-lg`}>
                        {status.charAt(0).toUpperCase() + status.slice(1)}
                    </Badge>
                </div>
            </CardHeader>
            <CardContent className="px-5 pb-5">
                <div className="flex items-center justify-between mb-4">
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className={`text-4xl font-bold cursor-help ${getScoreColor(score.total)} hover:scale-105 transition-transform`}>
                                    {score.total}
                                </div>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm bg-white text-stone-700 border-stone-200 p-4 shadow-lg rounded-xl">
                                <p className="font-semibold text-stone-800 text-base mb-2">Why this score?</p>
                                <p className="text-sm text-stone-600 leading-relaxed">{score.explanation}</p>
                                <div className="mt-3 pt-3 border-t border-stone-200 text-sm text-stone-500 space-y-1">
                                    <div className="flex justify-between">
                                        <span>Constraints:</span>
                                        <span className="font-medium text-stone-700">{score.breakdown.constraints}/50</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span>Experience:</span>
                                        <span className="font-medium text-stone-700">{score.breakdown.experience}/30</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span>Logistics:</span>
                                        <span className="font-medium text-stone-700">{score.breakdown.logistics}/20</span>
                                    </div>
                                </div>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                    <div className="text-right">
                        {candidate.city && (
                            <div className="text-sm text-stone-600 font-medium">{candidate.city}</div>
                        )}
                        {candidate.email && (
                            <div className="text-xs text-stone-400 truncate max-w-[160px]">{candidate.email}</div>
                        )}
                    </div>
                </div>

                {candidate.skills && candidate.skills.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                        {candidate.skills.slice(0, 4).map((skill, i) => (
                            <Badge key={i} variant="secondary" className="text-xs bg-stone-100 text-stone-600 px-2.5 py-0.5 rounded-md font-medium">
                                {skill}
                            </Badge>
                        ))}
                        {candidate.skills.length > 4 && (
                            <Badge variant="secondary" className="text-xs bg-stone-50 text-stone-400 px-2.5 py-0.5 rounded-md">
                                +{candidate.skills.length - 4}
                            </Badge>
                        )}
                    </div>
                )}

                {red_flags && red_flags.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-stone-100">
                        {red_flags.map((flag, i) => (
                            <span key={i} className="text-red-600 text-xs font-medium mr-2">
                                ⚠️ {flag}
                            </span>
                        ))}
                    </div>
                )}

                {status === 'new' && onInvite && (
                    <Button
                        size="sm"
                        className="w-full mt-4 bg-lime-500 hover:bg-lime-600 text-white rounded-xl font-medium shadow-sm hover:shadow"
                        onClick={handleInvite}
                        disabled={inviting}
                    >
                        {inviting ? '📧 Sending...' : '📧 Invite to Interview'}
                    </Button>
                )}
            </CardContent>
        </Card>
    );
}
