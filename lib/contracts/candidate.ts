import type { ParserOutput } from '@/lib/contracts/parser';

export type CandidateStatus = 'pending' | 'new' | 'invited' | 'interviewed' | 'hired';

export interface CandidateWithStatus {
    data: ParserOutput;
    status: CandidateStatus;
    id: string;
}
