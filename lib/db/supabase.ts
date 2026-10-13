import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { ParserOutput } from '@/lib/contracts/parser';
import type { ApplicationCompleteness } from '../contracts/application-completeness.ts';
import { loadApplicationCompleteness } from './application-completeness.ts';
import {
    buildApprovedCandidateScoreDetails,
    type ApprovedCandidateScoreDetails,
} from '../contracts/candidate-score.ts';
import {
    Agent1EvaluationSchema,
    RoleScoringPolicySchema,
    type RoleScoringPolicy,
} from '../contracts/resume-review.ts';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Fallback merchant ID used when no auth is in place (demo / local dev)
export const DEMO_MERCHANT_ID = process.env.DEMO_MERCHANT_ID || '00000000-0000-0000-0000-000000000001';

let supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
    if (!supabaseUrl) return null;
    
    // Use the Service Role Key on the server if available to seamlessly bypass RLS
    const key = typeof window === 'undefined' 
        ? (process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseKey)
        : supabaseKey;

    if (!key) {
        console.warn('[Supabase] Missing Supabase keys in environment');
        return null;
    }

    if (!supabase) {
        supabase = createClient(supabaseUrl, key);
    }
    return supabase;
}

// ─── Candidate Operations ────────────────────────────────────────────────────

export interface CandidateAnalysis {
    skills?: string[];
    experience_years?: number;
    applied_role?: string;
    breakdown?: ParserOutput['score']['breakdown'];
    explanation?: string;
    parsed_email?: string;
}

export interface CandidateRow {
    id?: string;
    merchant_id: string;
    job_id?: string;
    job_title?: string;
    name: string;
    email?: string;
    phone?: string;
    city?: string;
    status: string;
    resume_url: string;
    resume_text?: string;  // raw markdown from the document processor
    fit_score?: number | null;
    analysis?: CandidateAnalysis;
    approved_score?: ApprovedCandidateScoreDetails;
    application?: ApplicationCompleteness;
    red_flags?: string[];
    summary?: string;
    source: string;
    // pgvector halfvec: 3072-dim document embedding for semantic search
    // Supabase accepts this as a plain number[] and stores it in the halfvec(3072) column
    embedding?: number[];
}

export class CandidateReviewRequiredError extends Error {
    constructor() {
        super('Candidate scores require an approved human-review revision');
        this.name = 'CandidateReviewRequiredError';
    }
}

export class CandidateLoadError extends Error {
    constructor() {
        super('Saved applicants could not be loaded.');
        this.name = 'CandidateLoadError';
    }
}

export function assertCandidateHasNoUnreviewedScore(candidate: CandidateRow): void {
    if (
        candidate.fit_score !== undefined
        || candidate.analysis !== undefined
        || candidate.approved_score !== undefined
        || candidate.red_flags !== undefined
    ) {
        throw new CandidateReviewRequiredError();
    }
}

export async function saveCandidateToSupabase(candidate: CandidateRow): Promise<string | null> {
    assertCandidateHasNoUnreviewedScore(candidate);
    const db = getSupabase();
    if (!db) {
        console.log('[Supabase] Skipping save — not configured');
        return null;
    }

    try {
        const { data, error } = await db
            .from('candidates')
            .insert(candidate)
            .select('id')
            .single();

        if (error) {
            console.error('[Supabase] Candidate save failed', {
                code: typeof error.code === 'string' ? error.code.slice(0, 80) : 'unknown',
            });
            return null;
        }
        return data?.id || null;
    } catch (err) {
        console.error('[Supabase] Candidate save failed unexpectedly', {
            errorType: err instanceof Error ? err.name : 'UnknownError',
        });
        return null;
    }
}

export async function updateCandidateStatus(candidateId: string, status: string): Promise<boolean> {
    const db = getSupabase();
    if (!db) return false;

    try {
        const { error } = await db
            .from('candidates')
            .update({ status })
            .eq('id', candidateId);

        if (error) {
            console.error('[Supabase] Error updating status:', error);
            return false;
        }
        return true;
    } catch (err) {
        console.error('[Supabase] Unexpected error:', err);
        return false;
    }
}

export async function deleteCandidateFromSupabase(candidateId: string): Promise<boolean> {
    if (typeof window !== 'undefined') {
        // We are on the client; call our secure proxy API instead of hitting Supabase RLS directly
        try {
            const res = await fetch(`/api/candidates?id=${candidateId}`, { method: 'DELETE' });
            return res.ok;
        } catch (e) {
            console.error('[Supabase Proxy] Delete failed:', e);
            return false;
        }
    }

    const db = getSupabase();
    if (!db) return false;

    try {
        const { error } = await db
            .from('candidates')
            .delete()
            .eq('id', candidateId);

        if (error) {
            console.error('[Supabase] Error deleting candidate:', error);
            return false;
        }
        return true;
    } catch (err) {
        console.error('[Supabase] Unexpected error:', err);
        return false;
    }
}

export async function loadCandidatesFromSupabase(merchantId: string): Promise<CandidateRow[]> {
    if (typeof window !== 'undefined') {
        // We are on the client; call our secure proxy API instead of hitting Supabase RLS directly
        try {
            const res = await fetch(`/api/candidates?merchant_id=${merchantId}`);
            if (!res.ok) throw new CandidateLoadError();
            const candidates: unknown = await res.json();
            if (!Array.isArray(candidates)) throw new CandidateLoadError();
            return candidates as CandidateRow[];
        } catch {
            throw new CandidateLoadError();
        }
    }

    const db = getSupabase();
    if (!db) throw new CandidateLoadError();

    try {
        const { data, error } = await db
            .from('candidates')
            .select('*')
            .eq('merchant_id', merchantId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('[Supabase] Candidate load failed', {
                code: typeof error.code === 'string' ? error.code.slice(0, 80) : 'unknown',
            });
            throw new CandidateLoadError();
        }
        const candidates = (data || []) as CandidateRow[];
        const applicationPromise = loadApplicationCompleteness(db, candidates);
        const evaluations = candidates.map(candidate => ({
            candidate,
            evaluation: Agent1EvaluationSchema.safeParse(candidate.analysis),
        }));
        const roleIds = Array.from(new Set(evaluations.flatMap(({ candidate, evaluation }) => [
            ...(candidate.job_id ? [candidate.job_id] : []),
            ...(evaluation.success
                ? evaluation.data.ranked_roles.map(role => role.role_id)
                : []),
        ])));
        if (roleIds.length === 0) {
            const applications = await applicationPromise;
            return candidates.map(candidate => ({ ...candidate, application: applications.get(candidate.id || '') }));
        }

        const { data: jobRows, error: jobsError } = await db
            .from('jobs')
            .select('id,title,scoring_policy_id,scoring_policy_version,scoring_criteria')
            .eq('merchant_id', merchantId)
            .in('id', roleIds);
        if (jobsError) {
            console.error('[Supabase] Candidate score policy load failed', {
                code: typeof jobsError.code === 'string' ? jobsError.code.slice(0, 80) : 'unknown',
            });
            const applications = await applicationPromise;
            return candidates.map(candidate => ({ ...candidate, application: applications.get(candidate.id || '') }));
        }

        const policyByRole = new Map<string, RoleScoringPolicy>();
        const jobTitleByRole = new Map<string, string>();
        for (const row of jobRows || []) {
            if (typeof row.title === 'string') jobTitleByRole.set(row.id, row.title);
            const parsed = RoleScoringPolicySchema.safeParse({
                schema_version: '1.0',
                role_id: row.id,
                role_title: row.title,
                policy_identity: {
                    policy_id: row.scoring_policy_id,
                    policy_version: row.scoring_policy_version,
                },
                criteria: row.scoring_criteria,
            });
            if (parsed.success) policyByRole.set(parsed.data.role_id, parsed.data);
        }

        const applications = await applicationPromise;
        return evaluations.map(({ candidate, evaluation }) => {
            const titledCandidate = {
                ...candidate,
                application: applications.get(candidate.id || ''),
                job_title: candidate.job_id ? jobTitleByRole.get(candidate.job_id) : undefined,
            };
            if (!evaluation.success) return titledCandidate;
            const policies = evaluation.data.ranked_roles
                .map(role => policyByRole.get(role.role_id))
                .filter((policy): policy is RoleScoringPolicy => Boolean(policy));
            const approvedScore = buildApprovedCandidateScoreDetails(
                evaluation.data,
                policies,
                candidate.fit_score,
            );
            return approvedScore
                ? { ...titledCandidate, approved_score: approvedScore }
                : titledCandidate;
        });
    } catch (err) {
        if (!(err instanceof CandidateLoadError)) {
            console.error('[Supabase] Unexpected candidate load failure', {
                errorType: err instanceof Error ? err.name : 'UnknownError',
            });
        }
        throw new CandidateLoadError();
    }
}

// ─── Application Submission ──────────────────────────────────────────────────

export interface ApplicationSubmission {
    candidate_id?: string;
    role_id: string;
    basic_info: {
        full_name: string;
        email: string;
        phone: string;
    };
    knockout_answers: Record<string, string | boolean>;
    profile: {
        preferred_shifts: string[];
        days_available: string[];
        start_date: string;
        transportation: string;
        contact_preference: string;
    };
    skills: {
        years_experience: string;
        skills: string[];
        certifications: string[];
        languages: string[];
    };
    motivation: {
        why_work_here: string;
        superpower: string;
        above_and_beyond: string;
        skill_answers: Record<string, string>;
    };
}

export async function saveApplicationToSupabase(submission: ApplicationSubmission): Promise<string | null> {
    const db = getSupabase();
    if (!db) {
        console.log('[Supabase] Skipping application save — not configured');
        return null;
    }

    try {
        const { data, error } = await db
            .from('applications')
            .insert({
                candidate_id: submission.candidate_id,
                role_id: submission.role_id,
                data: submission,
                submitted_at: new Date().toISOString(),
            })
            .select('id')
            .single();

        if (error) {
            // Table might not exist yet — graceful fallback
            console.warn('[Supabase] Could not save application (table may not exist):', error.message);
            return null;
        }
        return data?.id || null;
    } catch (err) {
        console.error('[Supabase] Unexpected error:', err);
        return null;
    }
}
