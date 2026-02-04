
import { ParserOutput } from "../app/api/types";

// This file contains the pure logic for scoring.
// Currently, Gemini does the heavy lifting, but we can override or re-calculate here if needed.

export function calculateRedFlags(candidate: ParserOutput['candidate']): string[] {
    const flags: string[] = [];
    // Example logic we could implement:
    // if (candidate.experience_years < 1) flags.push("Low Experience");
    return flags;
}

export function normalizeScore(score: ParserOutput['score']): ParserOutput['score'] {
    // Ensure score is within bounds
    const total = Math.min(100, Math.max(0, score.total));
    return {
        ...score,
        total
    };
}
