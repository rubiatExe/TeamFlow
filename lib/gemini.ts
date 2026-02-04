
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ParserOutput, ParserOutputSchema } from "../app/api/types";

// Initialize Gemini
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
    console.warn("GOOGLE_API_KEY is not set in environment variables.");
}
const genAI = new GoogleGenerativeAI(apiKey || "MOCK_KEY");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

export async function parseResumeWithGemini(latex: string, context: { jobDescription?: string, dealbreakers?: string[] }): Promise<ParserOutput | null> {

    if (!apiKey || apiKey === "MOCK_KEY") {
        console.log("Mocking Gemini Response (No API Key provided)");
        // Return a partial mock that matches schemas
        return {
            candidate: {
                name: "Mock Candidate",
                email: "mock@example.com",
                skills: ["Mock Skill 1", "Mock Skill 2"],
            },
            score: {
                total: 0,
                breakdown: { constraints: 0, experience: 0, logistics: 0 },
                explanation: "Mock mode enabled."
            },
            red_flags: []
        }
    }

    const prompt = `
    You are an expert HR Recruiter Agent.
    
    Task: Extract structured data from the following Resume (in LaTeX format) and evaluate it against the provided Job Context.
    
    RESUME (LaTeX):
    """
    ${latex}
    """
    
    JOB CONTEXT:
    Dealbreakers: ${JSON.stringify(context.dealbreakers || [])}
    Job Description: ${context.jobDescription || "Generic Role"}
    
    INSTRUCTIONS:
    1. Extract the candidate's personal details (Name, Email, Phone, City).
    2. Suggest a list of Skills found in the resume.
    3. Analyze "Dealbreakers": For each dealbreaker, does the candidate PASS or FAIL?
    4. Provide a "Fit Score" breakdown:
       - Constraints (0-50): Percentage of dealbreakers passed.
       - Experience (0-30): Relevance of skills to the job.
       - Logistics (0-20): Estimate commute/location fit (if city is known).
    5. Identify any "Red Flags" (e.g. gaps > 6 months, job hopping).
    6. Write a short "Explanation" for the score.
    
    OUTPUT JSON FORMAT:
    {
      "candidate": {
        "name": "...",
        "email": "...",
        "phone": "...",
        "city": "...",
        "skills": ["..."],
        "experience_years": number
      },
      "score": {
        "total": number (0-100),
        "breakdown": {
          "constraints": number (0-50),
          "experience": number (0-30),
          "logistics": number (0-20)
        },
        "explanation": "..."
      },
      "red_flags": ["..."]
    }
  `;

    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });

        const responseText = result.response.text();
        const jsonArgs = JSON.parse(responseText);

        // Validate with Zod
        const validation = ParserOutputSchema.safeParse(jsonArgs);

        if (validation.success) {
            return validation.data;
        } else {
            console.error("Gemini Validation Error:", validation.error);
            return null;
        }

    } catch (error) {
        console.error("Gemini API Error:", error);
        return null;
    }
}
