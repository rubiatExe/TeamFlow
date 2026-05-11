import { NextRequest, NextResponse } from 'next/server';
import { saveApplicationToSupabase, ApplicationSubmission } from '@/lib/supabase';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();

        // Validate required fields
        const { roleId, basicInfo, knockoutAnswers, profile, skills, motivation, candidateId } = body;

        if (!basicInfo?.fullName || !basicInfo?.email || !roleId) {
            return NextResponse.json(
                { error: 'Missing required fields: fullName, email, and roleId' },
                { status: 400 }
            );
        }

        // Check knockout answers for dealbreaker failures
        const failedKnockouts = Object.entries(knockoutAnswers || {}).filter(
            ([, answer]) => answer === false || answer === 'no'
        );

        const passed = failedKnockouts.length === 0;

        // Build submission
        const submission: ApplicationSubmission = {
            candidate_id: candidateId,
            role_id: roleId,
            basic_info: {
                full_name: basicInfo.fullName,
                email: basicInfo.email,
                phone: basicInfo.phone || '',
            },
            knockout_answers: knockoutAnswers || {},
            profile: {
                preferred_shifts: profile?.preferredShifts || [],
                days_available: profile?.daysAvailable || [],
                start_date: profile?.startDate || '',
                transportation: profile?.transportation || '',
                contact_preference: profile?.contactPreference || '',
            },
            skills: {
                years_experience: skills?.yearsExperience || '',
                skills: skills?.skills || [],
                certifications: skills?.certifications || [],
                languages: skills?.languages || [],
            },
            motivation: {
                why_work_here: motivation?.whyWorkHere || '',
                superpower: motivation?.superpower || '',
                above_and_beyond: motivation?.aboveAndBeyond || '',
                skill_answers: motivation?.skillAnswers || {},
            },
        };

        console.log(`[Application] Received from ${basicInfo.fullName} for role: ${roleId}`);
        console.log(`[Application] Knockout result: ${passed ? 'PASSED' : 'FAILED'}`);

        // Save to Supabase
        const savedId = await saveApplicationToSupabase(submission);

        return NextResponse.json({
            success: true,
            passed,
            applicationId: savedId,
            failedKnockouts: failedKnockouts.map(([key]) => key),
            message: passed
                ? `Application from ${basicInfo.fullName} received successfully!`
                : `Thank you, ${basicInfo.fullName}. Unfortunately this role requires qualifications that don't match.`,
        });

    } catch (error) {
        console.error('[Application API Error]', error);
        return NextResponse.json(
            { error: 'Failed to process application' },
            { status: 500 }
        );
    }
}
