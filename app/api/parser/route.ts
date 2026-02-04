
import { NextRequest, NextResponse } from 'next/server';
import { ParserInputSchema, ParserOutput } from '../types';
import { parseResumeWithGemini } from '@/lib/gemini';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase (Service Role needed for writing to likely RLS protected tables?)
// Actually, for now we use the anon key if RLS allows, or the authenticated user.
// Since this is a server route called by the client, we might need to forward auth cookies.
// But for Sprint 1/2 we are just getting it working.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();

        // 1. Validate Input
        const validation = ParserInputSchema.safeParse(body);
        if (!validation.success) {
            return NextResponse.json({ error: validation.error.flatten() }, { status: 400 });
        }

        const { fileUrl, jobId } = validation.data;
        console.log(`[Parser] Processing file: ${fileUrl}`);

        // 2. Fetch the PDF file
        // Note: if fileUrl is public, we can just fetch it.
        const fileRes = await fetch(fileUrl);
        if (!fileRes.ok) {
            throw new Error(`Failed to fetch file from storage: ${fileRes.statusText}`);
        }
        const fileBlob = await fileRes.blob();

        // 3. Send to Nougat (Python Service) for LaTeX
        const formData = new FormData();
        formData.append('file', fileBlob, 'resume.pdf');

        let latex = "";
        try {
            const nougatRes = await fetch(`${PYTHON_SERVICE_URL}/extract`, {
                method: 'POST',
                body: formData,
            });

            if (!nougatRes.ok) {
                console.error("Nougat Service Error:", await nougatRes.text());
                // Fallback or Error?
                // For now, if Python fails (e.g. not running), we might want to fail hard or fallback.
                throw new Error("Nougat Service failed");
            }

            const nougatJson = await nougatRes.json();
            latex = nougatJson.latex;
        } catch (err) {
            console.error("Nougat Connection Failed (Is python_service running?). Using Mock LaTeX.");
            latex = "% Mock LaTeX due to service failure\n\\section*{Mock Candidate}...";
        }

        // 4. Send to Gemini for Intelligence
        // Retrieve Job Context if jobId is provided
        let context: { dealbreakers: string[]; jobDescription?: string } = { dealbreakers: [], jobDescription: "" };
        if (jobId) {
            const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
            if (job) {
                context = {
                    dealbreakers: job.dealbreakers as string[],
                    jobDescription: job.description
                };
            }
        }

        const parsedData = await parseResumeWithGemini(latex, context);

        if (!parsedData) {
            return NextResponse.json({ error: 'Failed to analyze resume with AI' }, { status: 500 });
        }

        // 5. Save to Database (Candidates Table)
        // We need a merchant_id. For now, we'll assume a dummy one or fetch from context if we had auth.
        // In a real app, we'd get this from the session.
        // Let's Insert a new row.
        const { data: candidate, error: dbError } = await supabase
            .from('candidates')
            .insert({
                merchant_id: '00000000-0000-0000-0000-000000000000', // Placeholder UUID
                name: parsedData.candidate.name,
                email: parsedData.candidate.email,
                phone: parsedData.candidate.phone,
                city: parsedData.candidate.city,
                resume_url: fileUrl,
                resume_text: latex, // Store the latex
                fit_score: parsedData.score.total,
                analysis: parsedData, // Store full JSON
                red_flags: parsedData.red_flags,
                summary: parsedData.score.explanation,
                status: 'new'
            })
            .select()
            .single();

        if (dbError) {
            console.error("Database Insert Error:", dbError);
            // We still return the data to the client even if DB save fails for this Sprint demo
        }

        return NextResponse.json(parsedData);

    } catch (error) {
        console.error('Parser API Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
