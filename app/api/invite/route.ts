import { NextRequest, NextResponse } from 'next/server';
import { generateMagicLink } from '@/lib/magic-link';
import { sendInviteSMS } from '@/lib/twilio';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { candidateId, candidateName, candidatePhone, candidateEmail, jobId, storeName } = body;

        if (!candidateId || !candidateName) {
            return NextResponse.json(
                { error: 'candidateId and candidateName are required' },
                { status: 400 }
            );
        }

        // Generate magic link
        const magicLink = generateMagicLink({
            candidateId,
            candidateName,
            jobId,
            merchantName: storeName || 'Our Store',
        });

        console.log(`[Invite] Generated magic link for ${candidateName}: ${magicLink}`);

        // Send SMS if phone number provided
        let smsResult = null;
        if (candidatePhone) {
            smsResult = await sendInviteSMS({
                candidateName,
                candidatePhone,
                storeName: storeName || 'Our Store',
                magicLink,
            });
        }

        // TODO: Update candidate status to 'invited' in Supabase
        // TODO: Send email if candidateEmail provided

        return NextResponse.json({
            success: true,
            magicLink,
            smsResult,
            message: `Invitation sent to ${candidateName}`,
        });

    } catch (error) {
        console.error('[Invite API Error]', error);
        return NextResponse.json(
            { error: 'Failed to send invitation' },
            { status: 500 }
        );
    }
}
