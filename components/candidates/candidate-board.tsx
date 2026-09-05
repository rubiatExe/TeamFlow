"use client";

import React from 'react';
import { CandidateCard } from './candidate-card';
import type { CandidateStatus, CandidateWithStatus } from '@/lib/contracts/candidate';

export type { CandidateStatus, CandidateWithStatus } from '@/lib/contracts/candidate';

interface CandidateBoardProps {
    candidates: CandidateWithStatus[];
    onStatusChange?: (candidateId: string, newStatus: CandidateStatus) => void;
    onInviteSuccess?: (candidateId: string) => void;
    onRemove?: (candidateId: string) => void;
}

const columns: { key: CandidateStatus; label: string; color: string; bg: string }[] = [
    { key: 'pending', label: '⏳ Pending', color: 'border-stone-400', bg: 'bg-stone-100' },
    { key: 'new', label: '🆕 New', color: 'border-blue-400', bg: 'bg-blue-50' },
    { key: 'invited', label: '📧 Invited', color: 'border-amber-400', bg: 'bg-amber-50' },
    { key: 'interviewed', label: '🎤 Interviewed', color: 'border-purple-400', bg: 'bg-purple-50' },
    { key: 'hired', label: '✅ Hired', color: 'border-lime-500', bg: 'bg-lime-50' },
];

export function CandidateBoard({ candidates, onStatusChange, onInviteSuccess, onRemove }: CandidateBoardProps) {
    const getCandidatesByStatus = (status: CandidateStatus) => {
        return candidates
            .filter(c => c.status === status)
            .sort((a, b) => (b.data.score?.total || 0) - (a.data.score?.total || 0));
    };

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-6">
            {columns.map(column => (
                <div
                    key={column.key}
                    className={`${column.bg} rounded-2xl p-5 border-t-4 ${column.color}`}
                >
                    <h3 className="text-base font-semibold text-stone-700 mb-4 flex items-center justify-between">
                        {column.label}
                        <span className="bg-white text-stone-500 px-3 py-1 rounded-full text-sm font-medium shadow-sm">
                            {getCandidatesByStatus(column.key).length}
                        </span>
                    </h3>

                    <div className="space-y-4 min-h-[200px]">
                        {getCandidatesByStatus(column.key).length === 0 ? (
                            <div className="text-center text-stone-600 text-sm py-12">
                                {column.key === 'pending' ? 'Upload resumes to start' :
                                    column.key === 'new' ? 'Candidates who completed portal' : 'No candidates yet'}
                            </div>
                        ) : (
                            getCandidatesByStatus(column.key).map((candidate) => (
                                <div key={candidate.id} className="group relative">
                                    <CandidateCard
                                        candidateId={candidate.id}
                                        data={candidate.data}
                                        status={candidate.status}
                                        onInvite={onInviteSuccess}
                                    />

                                    {/* Remove Button — visible on hover at all stages */}
                                    {onRemove && (
                                        <button
                                            type="button"
                                            aria-label={`Remove ${candidate.data.candidate.name}`}
                                            onClick={() => onRemove(candidate.id)}
                                            className="absolute top-2 right-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity min-w-11 min-h-11 flex items-center justify-center bg-white border border-stone-300 rounded-lg text-stone-600 hover:text-red-700 hover:border-red-400 hover:bg-red-50 shadow-sm cursor-pointer z-10 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600"
                                        >
                                            ✕
                                        </button>
                                    )}

                                    {/* Status Change Dropdown */}
                                    {onStatusChange && column.key !== 'hired' && (
                                        <div className="mt-3 opacity-100 md:absolute md:top-2 md:right-14 md:mt-0 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity">
                                            <label htmlFor={`candidate-status-${candidate.id}`} className="sr-only">
                                                Change status for {candidate.data.candidate.name}
                                            </label>
                                            <select
                                                id={`candidate-status-${candidate.id}`}
                                                aria-label={`Change status for ${candidate.data.candidate.name}`}
                                                className="min-h-11 w-full md:w-auto text-xs bg-white border border-stone-300 rounded-lg px-2 py-1 text-stone-700 shadow-sm cursor-pointer hover:border-stone-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-600"
                                                value={candidate.status}
                                                onChange={(e) => onStatusChange(candidate.id, e.target.value as CandidateStatus)}
                                            >
                                                {columns.filter(col => col.key !== 'invited' || candidate.status === 'invited').map(col => (
                                                    <option key={col.key} value={col.key}>
                                                        {col.label.replace(/^. /, '')}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
}
