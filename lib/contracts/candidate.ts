import type { ParserOutput } from '@/lib/contracts/parser';
import type { ApprovedCandidateScoreDetails, CandidateScoreDetails } from '@/lib/contracts/candidate-score';
import type { ApplicationCompleteness } from '@/lib/contracts/application-completeness';

export type CandidateStatus = 'pending' | 'new' | 'invited' | 'interviewed' | 'hired';

export type CandidateScoreCalculation =
    | 'legacy_preview'
    | 'weighted_policy'
    | 'sample_policy'
    | 'awaiting_review'
    | 'unavailable';

export type CandidateCardData = Omit<ParserOutput, 'candidate' | 'score'> & {
    application?: ApplicationCompleteness;
    candidate: ParserOutput['candidate'] & {
        applied_role_title?: string;
        applied_job_id?: string;
    };
    score: Omit<ParserOutput['score'], 'total'> & {
        total: number | null;
        calculation?: CandidateScoreCalculation;
        approved_policy?: ApprovedCandidateScoreDetails;
        sample_policy?: CandidateScoreDetails;
    };
};

export interface CandidateWithStatus {
    data: CandidateCardData;
    status: CandidateStatus;
    id: string;
}

export interface InviteRequest {
    candidateId: string;
    candidateName: string;
    candidatePhone: string;
    jobId?: string;
    storeName?: string;
}
