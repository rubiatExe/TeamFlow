"use client";

import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CAFE_ROLES, getRoleById } from '@/lib/roles';

interface SquareJob {
    id: string;
    title: string;
    wageMin: number;
    wageMax: number;
    isActive: boolean;
    roleId: string; // maps to CafeRole.id
}

interface StoreConfig {
    name: string;
    logo: string;
    primaryColor: string;
    address: string;
}

// Demo data simulating Square Labor API — now linked to café roles
const DEMO_JOBS: SquareJob[] = CAFE_ROLES.map(role => ({
    id: `job_${role.id}`,
    title: role.title,
    wageMin: role.wageRange.min,
    wageMax: role.wageRange.max,
    isActive: true,
    roleId: role.id,
}));

const DEMO_STORE: StoreConfig = {
    name: "Cocoa Bakery",
    logo: "☕",
    primaryColor: "#84cc16", // lime-500
    address: "123 Main St, Brooklyn, NY 11201",
};

interface SquareSettingsProps {
    onJobSelect?: (job: SquareJob) => void;
    selectedJobId?: string;
}

export function SquareSettings({ onJobSelect, selectedJobId }: SquareSettingsProps) {
    const [store] = useState<StoreConfig>({ ...DEMO_STORE, address: "475 Central Ave, Jersey City, NJ 07307" });
    const [jobs] = useState<SquareJob[]>(DEMO_JOBS);

    // Get dealbreakers for the currently selected role
    const selectedJob = jobs.find(j => j.id === selectedJobId);
    const selectedRole = selectedJob ? getRoleById(selectedJob.roleId) : undefined;

    return (
        <Card className="bg-white border border-stone-200 rounded-2xl shadow-sm">
            <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-lg font-semibold text-stone-800 flex items-center gap-2">
                        <span className="text-2xl">📋</span>
                        Store & Roles
                    </CardTitle>
                </div>
            </CardHeader>
            <CardContent className="space-y-6">
                {/* Store Info */}
                <div className="flex items-center gap-4 p-4 bg-stone-50 rounded-xl">
                    <div
                        className="w-14 h-14 rounded-xl flex items-center justify-center text-3xl"
                        style={{ backgroundColor: store.primaryColor + '20' }}
                    >
                        {store.logo}
                    </div>
                    <div className="flex-1">
                        <h3 className="font-semibold text-stone-800">{store.name}</h3>
                        <p className="text-sm text-stone-500">{store.address}</p>
                    </div>
                </div>

                {/* Job Roles */}
                <div>
                    <h4 className="text-sm font-medium text-stone-600 mb-3">
                        Active Job Roles
                    </h4>
                            <div className="space-y-2">
                                {jobs.filter(j => j.isActive).map(job => {
                                    const role = getRoleById(job.roleId);
                                    return (
                                        <div
                                            key={job.id}
                                            onClick={() => onJobSelect?.(job)}
                                            className={`flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all ${selectedJobId === job.id
                                                    ? 'bg-lime-50 border-2 border-lime-400'
                                                    : 'bg-stone-50 hover:bg-stone-100 border-2 border-transparent'
                                                }`}
                                        >
                                            <div className="flex items-center gap-2">
                                                <span className="text-lg">{role?.emoji || '📋'}</span>
                                                <div>
                                                    <span className="font-medium text-stone-800">{job.title}</span>
                                                    <span className="text-stone-400 text-sm ml-2">
                                                        ${job.wageMin}-${job.wageMax}/hr
                                                    </span>
                                                </div>
                                            </div>
                                            {selectedJobId === job.id && (
                                                <Badge className="bg-lime-500 text-white text-xs">
                                                    Selected
                                                </Badge>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Dealbreakers — now dynamically loaded from role config */}
                        <div className="pt-4 border-t border-stone-100">
                            <h4 className="text-sm font-medium text-stone-600 mb-3">
                                {selectedRole ? `${selectedRole.emoji} ${selectedRole.title} Dealbreakers` : 'Hiring Dealbreakers'}
                            </h4>
                            <div className="flex flex-wrap gap-2">
                                {selectedRole ? (
                                    selectedRole.dealbreakers.map((tag, i) => (
                                        <Badge
                                            key={i}
                                            variant="secondary"
                                            className="bg-red-50 text-red-600 px-3 py-1 rounded-lg text-xs"
                                        >
                                            ⚠️ {tag}
                                        </Badge>
                                    ))
                                ) : (
                                    ['Select a role above'].map((tag, i) => (
                                        <Badge
                                            key={i}
                                            variant="secondary"
                                            className="bg-stone-50 text-stone-400 px-3 py-1 rounded-lg text-xs"
                                        >
                                            {tag}
                                        </Badge>
                                    ))
                                )}
                            </div>
                        </div>
            </CardContent>
        </Card>
    );
}
