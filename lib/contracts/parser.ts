
import { z } from 'zod';
import { SchemaType, type ResponseSchema } from '@google/generative-ai';

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

// 1. Parser API Input - accepts either URL or direct file data
// POST /api/parser
export const ParserInputSchema = z.object({
    // Option 1: URL-based (legacy)
    fileUrl: z.string().url().optional(),
    // Option 2: Direct file data (base64)
    fileData: z.string().optional(),
    mimeType: z.string().optional(),
    fileName: z.string().optional(),
    // Job context
    jobId: z.string().uuid().optional(),
    // Role context — which café role is the candidate being evaluated for
    roleId: z.string().optional(),
});

export type ParserInput = z.infer<typeof ParserInputSchema>;

// 2. Parser API Output (The extracted & scored data)
export const ParserOutputSchema = z.object({
    candidate: z.object({
        name: z.string().min(1),
        email: z.string().optional().or(z.literal('')),
        phone: z.string().optional().or(z.literal('')),
        city: z.string().optional().or(z.literal('')),
        skills: z.array(z.string()).max(8),
        experience_years: z.number().int().min(0).max(80).optional(),
        applied_role: z.string().optional(),
    }),
    score: z.object({
        total: z.number().int().min(0).max(100),
        breakdown: z.object({
            constraints: z.number().int().min(0).max(50),
            experience: z.number().int().min(0).max(30),
            logistics: z.number().int().min(0).max(20),
        }),
        explanation: z.string().min(1).max(1_500),
    }),
    red_flags: z.array(z.string()).max(10),
    // 768-dim pgvector embedding from Agent 1 (text-embedding-004).
    // Passed through from the OCR response so the frontend can persist it
    // to the candidates table for semantic search via match_candidates().
    embedding: z.array(z.number()).length(768).nullable().optional(),
}).superRefine((output, context) => {
    const breakdownTotal =
        output.score.breakdown.constraints +
        output.score.breakdown.experience +
        output.score.breakdown.logistics;

    if (output.score.total !== breakdownTotal) {
        context.addIssue({
            code: 'custom',
            path: ['score', 'total'],
            message: `Total score must equal breakdown sum (${breakdownTotal})`,
        });
    }
});

export type ParserOutput = z.infer<typeof ParserOutputSchema>;

/**
 * Gemini's response contract. Keep this aligned with ParserOutputSchema.
 * Embeddings are produced by Agent 1, so they are intentionally absent here.
 */
export const PARSER_OUTPUT_RESPONSE_SCHEMA: ResponseSchema = {
    type: SchemaType.OBJECT,
    properties: {
        candidate: {
            type: SchemaType.OBJECT,
            properties: {
                name: {
                    type: SchemaType.STRING,
                    description: 'Candidate full name. Use Candidate when unavailable.',
                },
                email: {
                    type: SchemaType.STRING,
                    description: 'Exact email from the source, or an empty string.',
                },
                phone: {
                    type: SchemaType.STRING,
                    description: 'Exact phone number from the source, or an empty string.',
                },
                city: {
                    type: SchemaType.STRING,
                    description: 'Candidate city or location, or an empty string.',
                },
                skills: {
                    type: SchemaType.ARRAY,
                    description: 'Zero to eight role-relevant skills.',
                    items: { type: SchemaType.STRING },
                },
                experience_years: {
                    type: SchemaType.INTEGER,
                    description: 'Years of experience relevant to this role.',
                },
                applied_role: {
                    type: SchemaType.STRING,
                    description: 'The exact role ID supplied in the prompt.',
                },
            },
            required: [
                'name',
                'email',
                'phone',
                'city',
                'skills',
                'experience_years',
                'applied_role',
            ],
        },
        score: {
            type: SchemaType.OBJECT,
            properties: {
                total: {
                    type: SchemaType.INTEGER,
                    description: 'Integer from 0 to 100 equal to the three breakdown values.',
                },
                breakdown: {
                    type: SchemaType.OBJECT,
                    properties: {
                        constraints: {
                            type: SchemaType.INTEGER,
                            description: 'Constraint score from 0 to 50.',
                        },
                        experience: {
                            type: SchemaType.INTEGER,
                            description: 'Experience score from 0 to 30.',
                        },
                        logistics: {
                            type: SchemaType.INTEGER,
                            description: 'Logistics score from 0 to 20.',
                        },
                    },
                    required: ['constraints', 'experience', 'logistics'],
                },
                explanation: {
                    type: SchemaType.STRING,
                    description: 'Concise evidence-based explanation of the score.',
                },
            },
            required: ['total', 'breakdown', 'explanation'],
        },
        red_flags: {
            type: SchemaType.ARRAY,
            description: 'Zero to ten concise concerns supported by the candidate source.',
            items: { type: SchemaType.STRING },
        },
    },
    required: ['candidate', 'score', 'red_flags'],
};
