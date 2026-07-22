
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ParserOutput, ParserOutputSchema } from "../app/api/types";
import { getRoleOrDefault } from "./roles";

// Initialize Gemini
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
    console.warn("GOOGLE_API_KEY is not set in environment variables.");
}
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });



export async function parseResumeWithGemini(
    latex: string,
    context: { jobDescription?: string; dealbreakers?: string[]; roleId?: string }
): Promise<ParserOutput | null> {

    const role = getRoleOrDefault(context.roleId);

    if (!apiKey || apiKey === "MOCK_KEY") {
        console.log("Mocking Gemini Response (No API Key provided)");
        // Return a partial mock that matches schemas
        return {
            candidate: {
                name: "Mock Candidate",
                email: "mock@example.com",
                skills: ["Mock Skill 1", "Mock Skill 2"],
                applied_role: role.id,
            },
            score: {
                total: 0,
                breakdown: { constraints: 0, experience: 0, logistics: 0 },
                explanation: "Mock mode enabled."
            },
            red_flags: []
        }
    }

    const dealbreakersStr = role.dealbreakers.map((d, i) => `  ${i + 1}. ${d}`).join('\n');
    const essentialSkillsStr = role.essentialSkills.map(s => s.label.replace(/^. /, '')).join(', ');

    const prompt = `
    You are an expert HR Recruiter Agent analyzing a resume for a "${role.title}" position.
    
    ROLE: ${role.title} — ${role.description}
    
    RESUME (LaTeX):
    """
    ${latex}
    """
    
    DEALBREAKERS:
${dealbreakersStr}
    
    ESSENTIAL SKILLS: ${essentialSkillsStr}
    
    INSTRUCTIONS:
    1. Extract the candidate's personal details (Name, Email, Phone, City).
       - EMAIL EXTRACTION IS CRITICAL: Scan the entire document for email addresses. 
         Look for patterns like name@domain.com in headers, footers, contact sections, everywhere.
    2. List skills found in the resume, prioritizing matches with the ESSENTIAL SKILLS above.
    3. Analyze "Dealbreakers": For each dealbreaker, does the candidate PASS or FAIL?
    4. Provide a "Fit Score" breakdown:
       - Constraints (0-50): Percentage of dealbreakers passed.
       - Experience (0-30): Relevance of skills to the "${role.title}" role.
       - Logistics (0-20): Estimate commute/location fit (if city is known).
    5. Identify any "Red Flags" (e.g. gaps > 6 months, job hopping).
    6. Write a short "Explanation" for the score.
    
    OUTPUT JSON FORMAT:
    {
      "candidate": {
        "name": "...",
        "email": "exact email found or empty string",
        "phone": "...",
        "city": "...",
        "skills": ["..."],
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

        // Ensure applied_role is set
        if (jsonArgs.candidate && !jsonArgs.candidate.applied_role) {
            jsonArgs.candidate.applied_role = role.id;
        }

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
