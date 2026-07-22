import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Fallback merchant ID used when no auth is in place (demo / local dev)
export const DEMO_MERCHANT_ID = process.env.DEMO_MERCHANT_ID || '00000000-0000-0000-0000-000000000001';

let supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
    if (!supabaseUrl || !supabaseKey) {
        console.warn('[Supabase] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
        return null;
    }
    if (!supabase) {
        supabase = createClient(supabaseUrl, supabaseKey);
    }
    return supabase;
}

// ─── Candidate Operations ────────────────────────────────────────────────────

export interface CandidateRow {
    id?: string;
    merchant_id: string;
    job_id?: string;
    name: string;
    email?: string;
    phone?: string;
    city?: string;
    status: string;
    resume_url: string;
    resume_text?: string;  // raw markdown text from OCR Agent 1
    fit_score?: number;
    analysis?: Record<string, unknown>;
    red_flags?: string[];
    summary?: string;
    source: string;
    // pgvector: 768-dim embedding for semantic search (text-embedding-004)
    // Supabase accepts this as a plain number[] and stores it in the vector(768) column
    embedding?: number[];
}

export async function saveCandidateToSupabase(candidate: CandidateRow): Promise<string | null> {
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
            console.error('[Supabase] Error saving candidate:', error);
            return null;
        }
        return data?.id || null;
    } catch (err) {
        console.error('[Supabase] Unexpected error:', err);
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
    const db = getSupabase();
    if (!db) return [];

    try {
        const { data, error } = await db
            .from('candidates')
            .select('*')
            .eq('merchant_id', merchantId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('[Supabase] Error loading candidates:', error);
            return [];
        }
        return data || [];
    } catch (err) {
        console.error('[Supabase] Unexpected error:', err);
        return [];
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
