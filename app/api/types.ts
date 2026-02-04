
import { z } from 'zod';

// --- Database Models (Mirrors Supabase Schema) ---

export interface Merchant {
    id: string;
    email: string;
    store_name: string;
    square_merchant_id?: string;
    phone_number?: string;
}

export interface Job {
    id: string;
    merchant_id: string;
    title: string;
    wage_min?: number;
    wage_max?: number;
    is_active: boolean;
    dealbreakers: string[]; // JSONB array of strings (questions)
    nice_to_haves: string[];
    description?: string;
}

export interface Candidate {
    id: string;
    merchant_id: string;
    job_id?: string;
    name: string;
    email?: string;
    phone?: string;
    city?: string;
    status: 'new' | 'invited' | 'interviewed' | 'hired' | 'rejected';
    resume_url: string;
    fit_score?: number;
    red_flags: string[];
    summary?: string;
    source: 'upload' | 'scan';
    created_at: string;
}

// --- API Request/Response Schemas ---

// 1. Parser API Input
// POST /api/parser
export const ParserInputSchema = z.object({
    fileUrl: z.string().url(), // Path to the PDF in Supabase Storage
    jobId: z.string().uuid().optional(), // To fetch specific constraints
});

export type ParserInput = z.infer<typeof ParserInputSchema>;

// 2. Parser API Output (The extracted & scored data)
export const ParserOutputSchema = z.object({
    candidate: z.object({
        name: z.string(),
        email: z.string().email().optional().or(z.literal('')),
        phone: z.string().optional().or(z.literal('')),
        city: z.string().optional().or(z.literal('')),
        skills: z.array(z.string()),
        experience_years: z.number().optional(),
    }),
    score: z.object({
        total: z.number().min(0).max(100),
        breakdown: z.object({
            constraints: z.number(), // 50%
            experience: z.number(),  // 30%
            logistics: z.number(),   // 20%
        }),
        explanation: z.string(), // "Why?" tooltip
    }),
    red_flags: z.array(z.string()),
});

export type ParserOutput = z.infer<typeof ParserOutputSchema>;
