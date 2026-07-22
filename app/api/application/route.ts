import { NextRequest, NextResponse } from 'next/server';
import { saveApplicationToSupabase, saveCandidateToSupabase, ApplicationSubmission, CandidateRow, DEMO_MERCHANT_ID } from '@/lib/supabase';
import { callScorerAgent } from '@/lib/scorer';
import { getRoleOrDefault } from '@/lib/roles';

// Serverless function max duration for Gemini inference
export const maxDuration = 60;

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

        if (passed) {
            try {
                const role = getRoleOrDefault(roleId);
                const markdown = generateMarkdownFromSubmission(submission);
                
                console.log(`[Application] Running AI Scorer on Web Form for ${basicInfo.fullName}`);
                const aiResult = await callScorerAgent(markdown, role, 'Web_Form.md', true);

                const candidateRow: CandidateRow = {
                    merchant_id: DEMO_MERCHANT_ID,
                    name: basicInfo.fullName,
                    email: basicInfo.email,
                    phone: basicInfo.phone || '',
                    city: 'Local Area',
                    status: 'new',
                    resume_url: `webform_${savedId || Date.now()}`,
                    resume_text: markdown,
                    fit_score: aiResult.score.total,
                    summary: aiResult.score.explanation,
                    red_flags: aiResult.red_flags,
                    source: 'Web Form',
                    analysis: {
                        skills: aiResult.candidate.skills,
                        experience_years: aiResult.candidate.experience_years,
                        breakdown: aiResult.score.breakdown,
                        parsed_email: aiResult.candidate.email,
                    },
                };

                await saveCandidateToSupabase(candidateRow);
                console.log(`[Application] AI Scorer finished and saved candidate to dashboard.`);
            } catch (scoreErr) {
                console.error('[Application] Failed to run AI Scorer on Web Form:', scoreErr);
            }
        }

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
