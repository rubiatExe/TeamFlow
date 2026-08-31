
import { z } from 'zod';
import { SchemaType, type ResponseSchema } from '@google/generative-ai';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_NAME_CODE_POINTS = 255;
export const SUPPORTED_DOCUMENT_MIME_TYPES = [
    'application/pdf',
    'image/jpeg',
    'image/png',
] as const;

const maxBase64Characters = Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4;
const sharedBlankTextPattern = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]*$/u;
const unsafeFileNamePattern = /[\u0000-\u001f\u007f/\\]/u;
const validSecondCharactersBeforeDoublePadding = new Set(['A', 'Q', 'g', 'w']);
const validThirdCharactersBeforePadding = new Set(
    'AEIMQUYcgkosw048'.split(''),
);

function isBase64AlphabetCharacter(characterCode: number): boolean {
    return (characterCode >= 65 && characterCode <= 90)
        || (characterCode >= 97 && characterCode <= 122)
        || (characterCode >= 48 && characterCode <= 57)
        || characterCode === 43
        || characterCode === 47;
}

function isCanonicalBase64(value: string, paddingBytes: number): boolean {
    if (value.length % 4 !== 0) return false;
    const unpaddedEnd = value.length - paddingBytes;
    for (let index = 0; index < unpaddedEnd; index += 1) {
        if (!isBase64AlphabetCharacter(value.charCodeAt(index))) return false;
    }
    for (let index = unpaddedEnd; index < value.length; index += 1) {
        if (value[index] !== '=') return false;
    }
    if (paddingBytes === 2) {
        return validSecondCharactersBeforeDoublePadding.has(value[value.length - 3]);
    }
    if (paddingBytes === 1) {
        return validThirdCharactersBeforePadding.has(value[value.length - 2]);
    }
    return true;
}

const CanonicalBase64FileSchema = z.string().superRefine((value, context) => {
    if (value.length === 0) {
        context.addIssue({ code: 'custom', message: 'fileData must not be empty' });
        return;
    }
    if (value.length > maxBase64Characters) {
        context.addIssue({
            code: 'custom',
            message: `decoded file must not exceed ${MAX_DOCUMENT_BYTES} bytes`,
        });
        return;
    }
    const paddingBytes = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    const decodedBytes = (value.length / 4) * 3 - paddingBytes;
    if (decodedBytes > MAX_DOCUMENT_BYTES) {
        context.addIssue({
            code: 'custom',
            message: `decoded file must not exceed ${MAX_DOCUMENT_BYTES} bytes`,
        });
        return;
    }
    if (!isCanonicalBase64(value, paddingBytes)) {
        context.addIssue({
            code: 'custom',
            message: 'fileData must use canonical RFC 4648 base64 without whitespace',
        });
        return;
    }
});

const FileNameSchema = z.string().superRefine((value, context) => {
    if (value.length > MAX_FILE_NAME_CODE_POINTS * 2) {
        context.addIssue({
            code: 'custom',
            message: `fileName must contain at most ${MAX_FILE_NAME_CODE_POINTS} Unicode code points`,
        });
        return;
    }
    const codePointLength = Array.from(value).length;
    if (codePointLength > MAX_FILE_NAME_CODE_POINTS) {
        context.addIssue({
            code: 'custom',
            message: `fileName must contain at most ${MAX_FILE_NAME_CODE_POINTS} Unicode code points`,
        });
    }
    if (sharedBlankTextPattern.test(value)) {
        context.addIssue({ code: 'custom', message: 'fileName must not be blank' });
    }
    if (unsafeFileNamePattern.test(value)) {
        context.addIssue({
            code: 'custom',
            message: 'fileName must be a base name without control characters or path separators',
        });
    }
});

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

// 1. Parser API Input - accepts bounded inline data only. URL ingestion is disabled
// because fetching an untrusted URL here would expose an SSRF and unbounded-download path.
// POST /api/parser
export const ParserInputSchema = z.object({
    fileUrl: z.never().optional(),
    fileData: CanonicalBase64FileSchema,
    mimeType: z.enum(SUPPORTED_DOCUMENT_MIME_TYPES),
    fileName: FileNameSchema,
    // Job context
    jobId: z.string().uuid().optional(),
    // Role context — which café role is the candidate being evaluated for
    roleId: z.string().min(1).max(120).optional(),
}).strict();

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
    // 768-dim pgvector embedding from the document-processing stage.
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
 * Embeddings are produced upstream, so they are intentionally absent here.
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
