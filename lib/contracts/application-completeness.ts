export type ApplicationCompletionState =
  | 'complete'
  | 'submitted_incomplete'
  | 'in_progress'
  | 'not_submitted'
  | 'unknown';

export type ApplicationSectionId = 'contact' | 'role_questions' | 'availability' | 'experience' | 'motivation';

/** Evidence coverage only: completing a form never awards or removes fit-score points. */
export interface ApplicationCompleteness {
  state: ApplicationCompletionState;
  application_id?: string;
  role_id?: string;
  submitted_at?: string;
  completed_sections: number | null;
  total_sections: number;
  sections: Array<{ id: ApplicationSectionId; label: string; complete: boolean | null }>;
  missing_fields: string[];
  explanation: string;
}

/** Server-only source row. Raw application answers must not be added to card payloads. */
export interface ApplicationEvidenceRow {
  id: string;
  candidate_id?: string | null;
  role_id: string;
  data: unknown;
  submitted_at?: string | null;
}
