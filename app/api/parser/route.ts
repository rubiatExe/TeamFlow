
import { NextRequest, NextResponse } from 'next/server';
import { ParserInputSchema, ParserOutput, ParserOutputSchema } from '../types';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getRoleOrDefault } from '@/lib/roles';

// Initialize Gemini
const apiKey = process.env.GOOGLE_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const model = genAI?.getGenerativeModel({ model: 'gemini-flash-latest' });

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();

        // 1. Validate Input
        const validation = ParserInputSchema.safeParse(body);
        if (!validation.success) {
            return NextResponse.json({ error: validation.error.flatten() }, { status: 400 });
        }

        const { fileUrl, fileData, mimeType: inputMimeType, fileName, jobId, roleId } = validation.data;
        console.log(`[Parser] Processing: ${fileName || fileUrl || 'unknown'} for role: ${roleId || 'default'}`);

        let base64Data: string;
        let mimeType: string;

        // 2. Get file data - either from direct upload or URL
        if (fileData) {
            // Direct base64 data from client
            base64Data = fileData;
            mimeType = inputMimeType || 'application/pdf';
            console.log(`[Parser] Using direct file data, mime: ${mimeType}`);
        } else if (fileUrl) {
            // Fetch from URL (legacy)
            const fileRes = await fetch(fileUrl);
            if (!fileRes.ok) {
                throw new Error(`Failed to fetch file from storage: ${fileRes.statusText}`);
            }
            const fileBlob = await fileRes.blob();
            const arrayBuffer = await fileBlob.arrayBuffer();
            base64Data = Buffer.from(arrayBuffer).toString('base64');
            const contentType = fileRes.headers.get('content-type') || 'application/pdf';
            mimeType = contentType.includes('image') ? contentType : 'application/pdf';
        } else {
            return NextResponse.json({ error: 'No file data provided' }, { status: 400 });
        }

        // 3. Get Role-Specific Context
        const role = getRoleOrDefault(roleId);
        const dealbreakersStr = role.dealbreakers.map((d, i) => `  ${i + 1}. ${d}`).join('\n');
        const essentialSkillsStr = role.essentialSkills.map(s => s.label.replace(/^. /, '')).join(', ');
        const niceToHaveStr = role.niceToHaveSkills.map(s => s.label.replace(/^. /, '')).join(', ');

        // 4. Use Gemini to analyze the resume directly (multimodal)
        if (!model || !apiKey) {
            console.log('[Parser] No Gemini API key, returning mock data');
            const mockData: ParserOutput = {
                candidate: {
                    name: 'Sample Candidate',
                    email: 'sample@email.com',
                    skills: ['Communication', 'Customer Service'],
                    applied_role: role.id,
                },
                score: {
                    total: 75,
                    breakdown: { constraints: 40, experience: 20, logistics: 15 },
                    explanation: 'Mock data - No API key configured'
                },
                red_flags: []
            };
            return NextResponse.json(mockData);
        }

        const prompt = `
You are an expert HR Recruiter analyzing a resume/CV for a specific café position.

═══════════════════════════════════════════════════════
ROLE: ${role.title} (${role.emoji})
DESCRIPTION: ${role.description}
WAGE RANGE: $${role.wageRange.min}-$${role.wageRange.max}/hr
═══════════════════════════════════════════════════════

DEALBREAKERS (Must-Pass Criteria):
${dealbreakersStr}

ESSENTIAL SKILLS TO LOOK FOR:
${essentialSkillsStr}

NICE-TO-HAVE SKILLS (Bonus Points):
${niceToHaveStr}

═══════════════════════════════════════════════════════
EXTRACTION INSTRUCTIONS — READ CAREFULLY:
═══════════════════════════════════════════════════════

1. **EMAIL EXTRACTION (CRITICAL)**:
   - Scan the ENTIRE document for email addresses: headers, footers, sidebars, contact sections, and body text.
   - Look for patterns like: name@domain.com, name@domain.org, first.last@provider.com
   - If the document is an image, look for text near mail icons (✉️) or "Email:" labels.
   - If multiple emails exist, prefer a personal email over a work/university email.
   - Return the EXACT email string found. Do NOT guess or fabricate an email.
   - If absolutely no email is found, return an empty string "".

2. **CONTACT DETAILS**: Extract full name, phone number (with area code if visible), and city/location.

3. **SKILLS MATCHING (IMPORTANT — FILTER FOR RELEVANCE)**: 
   - ONLY return skills that are relevant to the "${role.title}" position.
   - First, check which of the ESSENTIAL SKILLS and NICE-TO-HAVE SKILLS listed above the candidate has (directly stated or clearly implied by their job history).
   - Then, include any OTHER skills from the resume that would be directly useful for a ${role.title} role in a café/restaurant setting.
   - Do NOT include generic skills like "Microsoft Office", "Communication", "Teamwork" unless they are specifically relevant to this role.
   - Do NOT include skills from unrelated industries (e.g., "Python programming" for a Barista role).
   - Keep the list concise: aim for 3-8 relevant skills maximum.

4. **EXPERIENCE**: Count total years of relevant work experience for a "${role.title}" position. Only count experience in food service, hospitality, retail, or directly transferable roles.

5. **SCORING** (0-100 total):
   - **Constraints (0-50)**: How many dealbreakers does the candidate likely pass? Award proportionally.
     For example, if there are ${role.dealbreakers.length} dealbreakers and the candidate clearly passes ${role.dealbreakers.length - 1}, score ~${Math.round(50 * (role.dealbreakers.length - 1) / role.dealbreakers.length)}/50.
   - **Experience (0-30)**: How well do the candidate's skills match the ESSENTIAL skills listed above?
     0 = no relevant skills, 15 = some match, 30 = excellent match.
   - **Logistics (0-20)**: If the candidate's city is mentioned, estimate commute feasibility.
     20 = very close/same city, 10 = moderate, 0 = very far or unknown.

6. **RED FLAGS**: Identify concerns like employment gaps > 6 months, job hopping (3+ jobs/year), unexplained career downgrades, or missing critical qualifications.

OUTPUT JSON FORMAT (respond with ONLY valid JSON, no markdown):
{
  "candidate": {
    "name": "Full name from resume",
    "email": "exact@email.found or empty string",
    "phone": "Phone number if found or empty string",
    "city": "City/location if found or empty string",
    "skills": ["only", "role-relevant", "skills", "from", "resume"],
    "experience_years": number,
    "applied_role": "${role.id}"
  },
  "score": {
    "total": number (0-100),
    "breakdown": {
      "constraints": number (0-50),
      "experience": number (0-30),
      "logistics": number (0-20)
    },
    "explanation": "2-3 sentence explanation of why this score was given, referencing specific skills and dealbreakers"
  },
  "red_flags": ["list of concerns, or empty array if none"]
}`;

        try {
            const result = await model.generateContent({
                contents: [{
                    role: 'user',
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType, data: base64Data } }
                    ]
                }],
                generationConfig: { responseMimeType: 'application/json' }
            });

            const responseText = result.response.text();
            console.log('[Parser] Gemini response received');

            const parsedData = JSON.parse(responseText);

            // Ensure applied_role is set even if Gemini omits it
            if (parsedData.candidate && !parsedData.candidate.applied_role) {
                parsedData.candidate.applied_role = role.id;
            }

            const validated = ParserOutputSchema.safeParse(parsedData);

            if (!validated.success) {
                console.error('[Parser] Validation failed:', validated.error);
                // Return what we got even if validation partially fails
                return NextResponse.json(parsedData);
            }

            console.log('[Parser] Successfully parsed candidate:', validated.data.candidate.name);
            console.log('[Parser] Email extracted:', validated.data.candidate.email || '(none)');
            console.log('[Parser] Role:', role.title, '| Score:', validated.data.score.total);
            return NextResponse.json(validated.data);

        } catch (geminiErr) {
            console.error('[Parser] Gemini error:', geminiErr);
            return NextResponse.json({
                error: 'Failed to analyze resume',
                details: geminiErr instanceof Error ? geminiErr.message : 'Unknown error'
            }, { status: 500 });
        }

    } catch (error) {
        console.error('[Parser] API Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

