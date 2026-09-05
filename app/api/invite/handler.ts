import { NextRequest, NextResponse } from 'next/server.js';
import { z } from 'zod';

import type { InviteRequest } from '../../../lib/contracts/candidate.ts';
import { updateCandidateStatus } from '../../../lib/db/supabase.ts';
import {
    readBoundedJson,
    RequestBodyTooLargeError,
} from '../../../lib/http/bounded-json.ts';
import { guardLegacyDemoRoute } from '../../../lib/http/legacy-demo-route.ts';
import { generateMagicLink } from '../../../lib/integrations/magic-link.ts';
import { sendInviteSMS } from '../../../lib/integrations/twilio.ts';

const MAX_INVITE_REQUEST_BYTES = 8 * 1024;

const InviteRequestSchema: z.ZodType<InviteRequest> = z.object({
    candidateId: z.string().trim().min(1).max(200),
    candidateName: z.string().trim().min(1).max(200),
    candidatePhone: z.string().trim().min(7).max(40),
    jobId: z.string().trim().min(1).max(200).optional(),
    storeName: z.string().trim().min(1).max(200).optional(),
}).strict();

export type InviteFailureCode =
    | 'INVALID_REQUEST'
    | 'REQUEST_TOO_LARGE'
    | 'DELIVERY_FAILED'
    | 'PERSISTENCE_UNAVAILABLE'
    | 'INTERNAL_ERROR';

type InviteRouteDependencies = {
    generateLink: typeof generateMagicLink;
    sendSms: typeof sendInviteSMS;
    updateStatus: typeof updateCandidateStatus;
};

const defaultDependencies: InviteRouteDependencies = {
    generateLink: generateMagicLink,
    sendSms: sendInviteSMS,
    updateStatus: updateCandidateStatus,
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
    code: InviteFailureCode,
    message: string,
    status: number,
    retryable: boolean,
): NextResponse {
    return json({ success: false, error: { code, message, retryable } }, status);
}

export function createInvitePost(dependencies: InviteRouteDependencies = defaultDependencies) {
    return async function invitePost(req: NextRequest): Promise<NextResponse> {
        const blocked = guardLegacyDemoRoute();
        if (blocked) return blocked as NextResponse;

        let rawBody: unknown;
        let deliveryWasAccepted = false;
        try {
            rawBody = await readBoundedJson(req, MAX_INVITE_REQUEST_BYTES);
        } catch (error) {
            if (error instanceof RequestBodyTooLargeError) {
                return failure('REQUEST_TOO_LARGE', 'The invitation request is too large.', 413, false);
            }
            return failure('INVALID_REQUEST', 'The invitation request is not valid JSON.', 400, false);
        }

        const parsedBody = InviteRequestSchema.safeParse(rawBody);
        if (!parsedBody.success) {
            return failure(
                'INVALID_REQUEST',
                'Candidate name, phone number, and identifier are required.',
                400,
                false,
            );
        }

        const body = parsedBody.data;
        try {
            const magicLink = dependencies.generateLink({
                candidateId: body.candidateId,
                candidateName: body.candidateName,
                jobId: body.jobId,
                merchantName: body.storeName || 'Our Store',
            });
            const smsResult = await dependencies.sendSms({
                candidateName: body.candidateName,
                candidatePhone: body.candidatePhone,
                storeName: body.storeName || 'Our Store',
                magicLink,
            });
            if (!smsResult.success) {
                return failure(
                    'DELIVERY_FAILED',
                    'The invitation was not sent. Please try again.',
                    502,
                    true,
                );
            }
            deliveryWasAccepted = true;

            const updated = await dependencies.updateStatus(body.candidateId, 'invited');
            if (!updated) {
                return failure(
                    'PERSISTENCE_UNAVAILABLE',
                    'Delivery was accepted, but the invited status was not saved. Contact support before retrying.',
                    503,
                    false,
                );
            }

            return json({
                success: true,
                delivery: smsResult.mock ? 'simulated' : 'accepted',
                message: smsResult.mock
                    ? 'Invitation simulated in the local demo.'
                    : 'Invitation accepted for delivery.',
            }, 200);
        } catch (error) {
            console.error('[Invite API] Invitation failed', {
                errorType: error instanceof Error ? error.name : 'UnknownError',
            });
            return failure(
                'INTERNAL_ERROR',
                deliveryWasAccepted
                    ? 'Delivery was accepted, but the invited status could not be confirmed. Contact support before retrying.'
                    : 'The invitation could not be processed. Please try again.',
                500,
                !deliveryWasAccepted,
            );
        }
    };
}
