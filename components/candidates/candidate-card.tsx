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
import { ParserOutput } from '@/lib/contracts/parser';
import type { InviteRequest } from '@/lib/contracts/candidate';
import { getRoleById } from '@/lib/domain/roles';

interface CandidateCardProps {
    candidateId?: string;
    data: ParserOutput;
    status?: 'pending' | 'new' | 'invited' | 'interviewed' | 'hired';
    onInvite?: (candidateId: string) => void;
}

const statusColors: Record<string, string> = {
    pending: 'bg-stone-100 text-stone-600',
    new: 'bg-blue-100 text-blue-700',
    invited: 'bg-amber-100 text-amber-700',
    interviewed: 'bg-purple-100 text-purple-700',
    hired: 'bg-lime-100 text-lime-700',
};

type InviteResult =
    | { success: true; delivery: 'accepted' | 'simulated'; message: string }
    | { success: false; error: { message: string; retryable: boolean } };

function parseInviteResult(value: unknown): InviteResult | null {
    if (!value || typeof value !== 'object') return null;
    const result = value as Record<string, unknown>;
    if (
        result.success === true
        && (result.delivery === 'accepted' || result.delivery === 'simulated')
        && typeof result.message === 'string'
    ) {
        return { success: true, delivery: result.delivery, message: result.message };
    }
    if (result.success !== false || !result.error || typeof result.error !== 'object') return null;
    const error = result.error as Record<string, unknown>;
    if (typeof error.message !== 'string' || typeof error.retryable !== 'boolean') return null;
    return {
        success: false,
        error: { message: error.message, retryable: error.retryable },
    };
}

export function CandidateCard({ candidateId, data, status = 'pending', onInvite }: CandidateCardProps) {
    const { candidate, score, red_flags } = data;
    const [inviting, setInviting] = useState(false);
    const [inviteFeedback, setInviteFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const isDemoCandidate = candidateId?.startsWith('demo_') ?? false;

    const handleInvite = async () => {
        if (!candidateId) return;
        if (!candidate.phone?.trim()) {
            setInviteFeedback({
                type: 'error',
                message: 'This candidate has no phone number available for a text invitation.',
            });
            return;
        }
        setInviting(true);
        setInviteFeedback(null);
        try {
            const inviteRequest: InviteRequest = {
                candidateId,
                candidateName: candidate.name,
                candidatePhone: candidate.phone,
                storeName: "Cocoa Bakery",
            };
            const res = await fetch('/api/invite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(inviteRequest),
            });
            const result = parseInviteResult(await res.json().catch(() => null));
            if (!res.ok || !result?.success) {
                setInviteFeedback({
                    type: 'error',
                    message: result && !result.success
                        ? result.error.message
                        : 'The invitation was not sent. Please try again.',
                });
                return;
            }

            setInviteFeedback({ type: 'success', message: result.message });
            onInvite?.(candidateId);
        } catch {
            setInviteFeedback({
                type: 'error',
                message: 'The invitation service could not be reached. Please try again.',
            });
        } finally {
            setInviting(false);
        }
    };

    const getScoreColor = (total: number) => {
        if (total >= 80) return 'text-lime-600';
        if (total >= 50) return 'text-amber-600';
        return 'text-red-600';
    };

    const appliedRole = candidate.applied_role ? getRoleById(candidate.applied_role) : undefined;

    return (
        <Card className="bg-white border border-stone-200 hover:border-stone-300 transition-all duration-200 shadow-sm hover:shadow-md rounded-2xl">
            <CardHeader className="pb-3 pt-5 px-5">
                <div className="flex justify-between items-start gap-2">
                    <div>
                        <CardTitle className="text-lg font-semibold text-stone-800 leading-tight">
                            {candidate.name}
                        </CardTitle>
                        {appliedRole && (
                            <span className="text-xs text-stone-600 mt-0.5 inline-flex items-center gap-1">
                                {appliedRole.emoji} {appliedRole.title}
                            </span>
                        )}
                        {isDemoCandidate && (
                            <span className="mt-1 block text-xs font-medium text-amber-800">Synthetic demo record</span>
                        )}
                    </div>
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
                                <button
                                    type="button"
                                    aria-label={`Demo fit score ${score.total}. Show score explanation`}
                                    className={`min-h-11 min-w-11 rounded-lg text-4xl font-bold cursor-help focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600 focus-visible:ring-offset-2 ${getScoreColor(score.total)} hover:scale-105 transition-transform`}
                                >
                                    {score.total}
                                </button>
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
                            <div className="text-xs text-stone-600 truncate max-w-[160px]">{candidate.email}</div>
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
                            <Badge variant="secondary" className="text-xs bg-stone-50 text-stone-600 px-2.5 py-0.5 rounded-md">
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

                {(status === 'pending' || status === 'new') && onInvite && (
                    <div className="mt-4">
                        <Button
                            size="sm"
                            className={`min-h-11 w-full rounded-xl font-medium shadow-sm hover:shadow ${status === 'pending'
                                    ? 'bg-amber-500 hover:bg-amber-600 text-stone-950'
                                    : 'bg-lime-600 hover:bg-lime-700 text-white'
                                }`}
                            onClick={handleInvite}
                            disabled={inviting || !candidate.phone}
                        >
                            {inviting ? 'Sending invitation…' : candidate.phone ? 'Send invite by text' : 'Phone number required'}
                        </Button>
                        <p
                            role={inviteFeedback?.type === 'error' ? 'alert' : 'status'}
                            aria-live="polite"
                            className={`mt-2 min-h-5 text-xs ${inviteFeedback?.type === 'error' ? 'text-red-700' : 'text-lime-800'}`}
                        >
                            {inviteFeedback?.message}
                        </p>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
