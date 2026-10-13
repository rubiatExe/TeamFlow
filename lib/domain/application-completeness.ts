import type {
  ApplicationCompleteness,
  ApplicationEvidenceRow,
  ApplicationSectionId,
} from '../contracts/application-completeness.ts';
import { getRoleById, isRoleQuestionAnswerTypeValid } from './roles.ts';

const SECTION_LABELS: Array<{ id: ApplicationSectionId; label: string }> = [
  { id: 'contact', label: 'Contact details' },
  { id: 'role_questions', label: 'Role questions' },
  { id: 'availability', label: 'Availability' },
  { id: 'experience', label: 'Experience & skills' },
  { id: 'motivation', label: 'About you' },
];

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hasList(value: unknown): boolean {
  return Array.isArray(value) && value.some(item => text(item).length > 0);
}

export function unknownApplicationCompleteness(
  explanation = 'Application status is unavailable. No completion or scoring assumption was made.',
): ApplicationCompleteness {
  return {
    state: 'unknown',
    completed_sections: null,
    total_sections: SECTION_LABELS.length,
    sections: SECTION_LABELS.map(section => ({ ...section, complete: null })),
    missing_fields: [],
    explanation,
  };
}

/** Only call with [] when the scoped application lookup actually succeeded. */
export function summarizeApplicationCompleteness(rows: ApplicationEvidenceRow[]): ApplicationCompleteness {
  if (rows.length === 0) {
    return {
      state: 'not_submitted',
      completed_sections: null,
      total_sections: SECTION_LABELS.length,
      sections: SECTION_LABELS.map(section => ({ ...section, complete: null })),
      missing_fields: [],
      explanation: 'No saved application was found. Unsaved form progress is not tracked; the résumé may still provide relevant evidence.',
    };
  }

  // Prefer the latest submitted record, not an older complete form or an undated draft.
  const row = [...rows].sort((left, right) => {
    const leftDate = Date.parse(left.submitted_at ?? '');
    const rightDate = Date.parse(right.submitted_at ?? '');
    return (Number.isFinite(rightDate) ? rightDate : -1) - (Number.isFinite(leftDate) ? leftDate : -1)
      || left.id.localeCompare(right.id);
  })[0];
  const role = getRoleById(row.role_id);
  const submittedAt = row.submitted_at && Number.isFinite(Date.parse(row.submitted_at)) ? row.submitted_at : undefined;
  if (!role || !row.data || typeof row.data !== 'object' || Array.isArray(row.data)
    || (row.submitted_at != null && !submittedAt)) {
    return {
      ...unknownApplicationCompleteness('A saved application exists, but its form requirements or answers could not be verified.'),
      application_id: row.id,
      role_id: row.role_id,
      submitted_at: submittedAt,
    };
  }

  const data = object(row.data);
  const contact = object(data.basic_info);
  const answers = object(data.knockout_answers);
  const profile = object(data.profile);
  const skills = object(data.skills);
  const motivation = object(data.motivation);
  const missingBySection: Record<ApplicationSectionId, string[]> = {
    contact: [
      ...(text(contact.full_name).length >= 2 ? [] : ['Full name']),
      ...(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(contact.email)) ? [] : ['Email address']),
      ...(text(contact.phone).replace(/\D/g, '').length >= 10 ? [] : ['Phone number']),
    ],
    // A negative answer is still a completed answer; completeness is not suitability.
    role_questions: role.questions.knockout.flatMap(question => {
      const answer = answers[question.id];
      return (typeof answer === 'string' || typeof answer === 'boolean') && isRoleQuestionAnswerTypeValid(question, answer)
        ? []
        : [`Role question: ${question.question}`];
    }),
    availability: [
      ...(hasList(profile.preferred_shifts) ? [] : ['Preferred shifts']),
      ...(hasList(profile.days_available) ? [] : ['Available days']),
      ...(text(profile.transportation) ? [] : ['Transportation response']),
      ...(text(profile.contact_preference) ? [] : ['Contact preference']),
    ],
    experience: [
      ...(text(skills.years_experience) ? [] : ['Experience response']),
      ...(hasList(skills.skills) ? [] : ['Skills response']),
    ],
    motivation: [
      ...(text(motivation.why_work_here).length >= (role.questions.motivation[0]?.minChars || 50) ? [] : ['Primary motivation response']),
      ...(text(motivation.superpower) ? [] : ['Strength response']),
    ],
  };
  const sections = SECTION_LABELS.map(section => ({ ...section, complete: missingBySection[section.id].length === 0 }));
  const missingFields = sections.flatMap(section => missingBySection[section.id]);
  const state = !submittedAt ? 'in_progress' : missingFields.length ? 'submitted_incomplete' : 'complete';
  return {
    state,
    application_id: row.id,
    role_id: row.role_id,
    submitted_at: submittedAt,
    completed_sections: sections.filter(section => section.complete).length,
    total_sections: sections.length,
    sections,
    missing_fields: missingFields,
    explanation: state === 'complete'
      ? 'All required form sections are filled. This confirms evidence coverage, not that any hiring criterion is met.'
      : state === 'in_progress'
        ? 'A saved form exists without a submission timestamp. Its answers are not a completed application.'
        : 'The application was submitted, but some required responses are missing. Missing information is not evidence that a criterion is unmet.',
  };
}
