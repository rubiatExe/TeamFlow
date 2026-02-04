"use client";

import React from 'react';
import { CandidateCard } from './candidate-card';
import { ParserOutput } from '@/app/api/types';

export type CandidateStatus = 'new' | 'invited' | 'interviewed' | 'hired';

export interface CandidateWithStatus {
    data: ParserOutput;
    status: CandidateStatus;
    id: string;
}

interface CandidateBoardProps {
    candidates: CandidateWithStatus[];
    onStatusChange?: (candidateId: string, newStatus: CandidateStatus) => void;
}

const columns: { key: CandidateStatus; label: string; color: string; bg: string }[] = [
    { key: 'new', label: '🆕 New', color: 'border-blue-400', bg: 'bg-blue-50' },
    { key: 'invited', label: '📧 Invited', color: 'border-amber-400', bg: 'bg-amber-50' },
    { key: 'interviewed', label: '🎤 Interviewed', color: 'border-purple-400', bg: 'bg-purple-50' },
    { key: 'hired', label: '✅ Hired', color: 'border-lime-500', bg: 'bg-lime-50' },
];

export function CandidateBoard({ candidates, onStatusChange }: CandidateBoardProps) {
    const getCandidatesByStatus = (status: CandidateStatus) => {
        return candidates
            .filter(c => c.status === status)
            .sort((a, b) => (b.data.score?.total || 0) - (a.data.score?.total || 0));
    };

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
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
                            <div className="text-center text-stone-400 text-sm py-12">
                                {column.key === 'new' ? 'Drop resumes to add' : 'No candidates yet'}
                            </div>
                        ) : (
                            getCandidatesByStatus(column.key).map((candidate) => (
                                <div key={candidate.id} className="group relative">
                                    <CandidateCard
                                        candidateId={candidate.id}
                                        data={candidate.data}
                                        status={candidate.status}
                                        onInvite={(id) => onStatusChange?.(id, 'invited')}
                                    />

                                    {/* Status Change Dropdown */}
                                    {onStatusChange && column.key !== 'hired' && (
                                        <div className="absolute top-3 right-14 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <select
                                                className="text-xs bg-white border border-stone-200 rounded-lg px-2 py-1 text-stone-600 shadow-sm cursor-pointer hover:border-stone-300"
                                                value={candidate.status}
                                                onChange={(e) => onStatusChange(candidate.id, e.target.value as CandidateStatus)}
                                            >
                                                {columns.map(col => (
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
