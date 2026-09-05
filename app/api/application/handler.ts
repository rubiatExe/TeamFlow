import { NextRequest, NextResponse } from 'next/server.js';
import { z } from 'zod';

import {
    saveApplicationToSupabase,
    saveCandidateToSupabase,
    type ApplicationSubmission,
    type CandidateRow,
    DEMO_MERCHANT_ID,
} from '../../../lib/db/supabase.ts';
import {
    readBoundedJson,
    RequestBodyTooLargeError,
} from '../../../lib/http/bounded-json.ts';
import { guardLegacyDemoRoute } from '../../../lib/http/legacy-demo-route.ts';
import {
    getRoleById,
    isRoleQuestionAnswerTypeValid,
    isRoleQuestionFailure,
} from '../../../lib/domain/roles.ts';

const MAX_APPLICATION_REQUEST_BYTES = 64 * 1024;

const StringListSchema = z.array(z.string().trim().min(1).max(120)).max(50);
const ApplicationRequestSchema = z.object({
    candidateId: z.string().trim().min(1).max(200).optional(),
    roleId: z.string().trim().min(1).max(100),
    basicInfo: z.object({
        fullName: z.string().trim().min(2).max(200),
        email: z.email().max(320),
        phone: z.string().trim().max(40).default(''),
    }).strict(),
    knockoutAnswers: z.record(
        z.string().trim().min(1).max(100),
        z.union([z.string().max(500), z.boolean()]),
    ).default({}),
    profile: z.object({
        preferredShifts: StringListSchema.default([]),
        daysAvailable: StringListSchema.default([]),
        startDate: z.string().trim().max(40).default(''),
        transportation: z.string().trim().max(100).default(''),
        contactPreference: z.string().trim().max(100).default(''),
    }).strict(),
    skills: z.object({
        yearsExperience: z.string().trim().max(100).default(''),
        skills: StringListSchema.default([]),
        certifications: StringListSchema.default([]),
        languages: StringListSchema.default([]),
    }).strict(),
    motivation: z.object({
        whyWorkHere: z.string().max(2_000).default(''),
        superpower: z.string().max(500).default(''),
        aboveAndBeyond: z.string().max(2_000).default(''),
        skillAnswers: z.record(z.string().max(100), z.string().max(2_000)).default({}),
    }).strict(),
}).strict();

export type ApplicationFailureCode =
    | 'INVALID_REQUEST'
    | 'REQUEST_TOO_LARGE'
    | 'PERSISTENCE_UNAVAILABLE'
    | 'INTERNAL_ERROR';

type ApplicationRouteDependencies = {
    saveApplication: typeof saveApplicationToSupabase;
    saveCandidate: typeof saveCandidateToSupabase;
};

const defaultDependencies: ApplicationRouteDependencies = {
    saveApplication: saveApplicationToSupabase,
    saveCandidate: saveCandidateToSupabase,
};

function json(body: unknown, status: number): NextResponse {
    return NextResponse.json(body, {
        status,
        headers: {
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}

function failure(
    code: ApplicationFailureCode,
    message: string,
    status: number,
    retryable: boolean,
): NextResponse {
    return json({ success: false, error: { code, message, retryable } }, status);
}

function generateMarkdownFromSubmission(submission: ApplicationSubmission): string {
    const { basic_info, profile, skills, motivation } = submission;

    return `
# ${basic_info.full_name}

**Email:** ${basic_info.email}
**Phone:** ${basic_info.phone || 'Not provided'}
**Location:** ${profile.transportation ? 'Local area (Has transportation)' : 'Local area'}

## Availability
- **Preferred Shifts:** ${profile.preferred_shifts.join(', ') || 'Not specified'}
- **Days Available:** ${profile.days_available.join(', ') || 'Not specified'}
- **Available to Start:** ${profile.start_date || 'Not specified'}

## Experience & Skills
- **Years of Experience:** ${skills.years_experience}
- **Relevant Skills:** ${skills.skills.join(', ') || 'None listed'}
- **Languages:** ${skills.languages.join(', ') || 'English'}
- **Certifications:** ${skills.certifications.join(', ') || 'None'}

## Motivation & Personality
**Why do you want to work here?**
${motivation.why_work_here || 'No answer provided.'}

**What is your superpower?**
${motivation.superpower || 'No answer provided.'}

**Tell us about a time you went above and beyond:**
${motivation.above_and_beyond || 'No answer provided.'}
    `.trim();
}

export function createApplicationPost(
    dependencies: ApplicationRouteDependencies = defaultDependencies,
) {
    return async function applicationPost(req: NextRequest): Promise<NextResponse> {
        const blocked = guardLegacyDemoRoute();
        if (blocked) return blocked as NextResponse;

        let rawBody: unknown;
        try {
            rawBody = await readBoundedJson(req, MAX_APPLICATION_REQUEST_BYTES);
        } catch (error) {
            if (error instanceof RequestBodyTooLargeError) {
                return failure('REQUEST_TOO_LARGE', 'The application is too large to submit.', 413, false);
            }
            return failure('INVALID_REQUEST', 'The application request is not valid JSON.', 400, false);
        }

        const parsedBody = ApplicationRequestSchema.safeParse(rawBody);
        if (!parsedBody.success) {
            return failure('INVALID_REQUEST', 'Please review the required application fields.', 400, false);
        }

        const body = parsedBody.data;
        const role = getRoleById(body.roleId);
        if (!role) {
            return failure('INVALID_REQUEST', 'Please choose a supported role.', 400, false);
        }
        const expectedQuestionIds = new Set(role.questions.knockout.map(question => question.id));
        const suppliedQuestionIds = Object.keys(body.knockoutAnswers);
        if (
            suppliedQuestionIds.length !== expectedQuestionIds.size
            || suppliedQuestionIds.some(questionId => !expectedQuestionIds.has(questionId))
            || role.questions.knockout.some(question => {
                const answer = body.knockoutAnswers[question.id];
                return answer === undefined || !isRoleQuestionAnswerTypeValid(question, answer);
            })
        ) {
            return failure(
                'INVALID_REQUEST',
                'Please answer every required role question using the expected response type.',
                400,
                false,
            );
        }
        const failedKnockouts = role.questions.knockout.filter(question =>
            isRoleQuestionFailure(question, body.knockoutAnswers[question.id]),
        );
        const passed = failedKnockouts.length === 0;

        const submission: ApplicationSubmission = {
            candidate_id: body.candidateId,
            role_id: body.roleId,
            basic_info: {
                full_name: body.basicInfo.fullName,
                email: body.basicInfo.email,
                phone: body.basicInfo.phone,
            },
            knockout_answers: body.knockoutAnswers,
            profile: {
                preferred_shifts: body.profile.preferredShifts,
                days_available: body.profile.daysAvailable,
                start_date: body.profile.startDate,
                transportation: body.profile.transportation,
                contact_preference: body.profile.contactPreference,
            },
            skills: {
                years_experience: body.skills.yearsExperience,
                skills: body.skills.skills,
                certifications: body.skills.certifications,
                languages: body.skills.languages,
            },
            motivation: {
                why_work_here: body.motivation.whyWorkHere,
                superpower: body.motivation.superpower,
                above_and_beyond: body.motivation.aboveAndBeyond,
                skill_answers: body.motivation.skillAnswers,
            },
        };

        let applicationWasSaved = false;
        try {
            const applicationId = await dependencies.saveApplication(submission);
            if (!applicationId) {
                return failure(
                    'PERSISTENCE_UNAVAILABLE',
                    'Your application was not saved. Your answers are still here; please try again.',
                    503,
                    true,
                );
            }
            applicationWasSaved = true;

            const candidateRow: CandidateRow = {
                merchant_id: DEMO_MERCHANT_ID,
                name: body.basicInfo.fullName,
                email: body.basicInfo.email,
                phone: body.basicInfo.phone,
                city: 'Local Area',
                status: 'new',
                resume_url: `webform_${applicationId}`,
                resume_text: generateMarkdownFromSubmission(submission),
                summary: passed
                    ? 'Awaiting authorized human review'
                    : 'Required responses flagged for authorized human review',
                source: 'Web Form',
            };
            const candidateRecordId = await dependencies.saveCandidate(candidateRow);
            if (!candidateRecordId) {
                return failure(
                    'PERSISTENCE_UNAVAILABLE',
                    'The application could not be finalized. Please contact the employer before retrying.',
                    503,
                    false,
                );
            }

            return json({
                success: true,
                passed,
                applicationId,
                failedKnockouts: failedKnockouts.map(question => question.id),
                message: 'Application received.',
            }, 201);
        } catch (error) {
            console.error('[Application API] Submission failed', {
                errorType: error instanceof Error ? error.name : 'UnknownError',
            });
            return failure(
                'INTERNAL_ERROR',
                applicationWasSaved
                    ? 'The application could not be finalized. Please contact the employer before retrying.'
                    : 'The application could not be processed. Please try again.',
                500,
                !applicationWasSaved,
            );
        }
    };
}
