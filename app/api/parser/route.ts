
import { NextRequest, NextResponse } from 'next/server';
import { ParserInputSchema, ParserOutput, ParserOutputSchema } from '../types';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini
const apiKey = process.env.GOOGLE_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const model = genAI?.getGenerativeModel({ model: 'gemini-2.0-flash' });

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();

        // 1. Validate Input
        const validation = ParserInputSchema.safeParse(body);
        if (!validation.success) {
            return NextResponse.json({ error: validation.error.flatten() }, { status: 400 });
        }

        const { fileUrl, fileData, mimeType: inputMimeType, fileName, jobId } = validation.data;
        console.log(`[Parser] Processing: ${fileName || fileUrl || 'unknown'}`);

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

        // 3. Get Job Context 
        const context = {
            dealbreakers: ['Weekend availability required', 'Must be 18+'],
            jobDescription: 'Barista position at a coffee shop'
        };

        // 4. Use Gemini to analyze the resume directly (multimodal)
        if (!model || !apiKey) {
            console.log('[Parser] No Gemini API key, returning mock data');
            const mockData: ParserOutput = {
                candidate: {
                    name: 'Sample Candidate',
                    email: 'sample@email.com',
                    skills: ['Communication', 'Customer Service'],
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
You are an expert HR Recruiter analyzing a resume for a job position.

JOB CONTEXT:
- Position: ${context.jobDescription}
- Dealbreakers: ${JSON.stringify(context.dealbreakers)}

TASK: Analyze this resume and extract the following information. Be thorough and accurate.

OUTPUT JSON FORMAT (respond with ONLY valid JSON):
{
  "candidate": {
    "name": "Full name from resume",
    "email": "Email if found",
    "phone": "Phone if found", 
    "city": "City/location if found",
    "skills": ["list", "of", "skills"],
    "experience_years": number
  },
  "score": {
    "total": number (0-100 fit score),
    "breakdown": {
      "constraints": number (0-50, dealbreakers passed),
      "experience": number (0-30, skill match),
      "logistics": number (0-20, location fit)
    },
    "explanation": "Brief explanation of the score"
  },
  "red_flags": ["any concerns like employment gaps, job hopping, etc"]
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
            const validated = ParserOutputSchema.safeParse(parsedData);

            if (!validated.success) {
                console.error('[Parser] Validation failed:', validated.error);
                // Return what we got even if validation partially fails
                return NextResponse.json(parsedData);
            }

            console.log('[Parser] Successfully parsed candidate:', validated.data.candidate.name);
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

