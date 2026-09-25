import { z } from 'zod';

import type { CandidateStatus, CandidateWithStatus } from '../contracts/candidate.ts';
import { SYNTHETIC_CANDIDATE_CORPUS } from './demo-semantic-search-data.ts';
import { CAFE_ROLES, getRoleOrDefault } from './roles.ts';

export interface HiringPersona {
  jobTitle: string;
  wageMin: number;
  wageMax: number;
  dealbreakers: string[];
  niceToHaves: string[];
  storeLocation: string;
}

export const DEMO_WORKSPACE_STORAGE_KEY = 'teamflow-fictional-workspace:v1';
const profileById = new Map(SYNTHETIC_CANDIDATE_CORPUS.map(profile => [profile.candidateRef as string, profile]));
const roleIds = new Set(CAFE_ROLES.map(role => role.id));

export function isDemoCandidateId(candidateId: string): boolean {
  return profileById.has(candidateId);
}

export function getDemoProfile(candidateId: string) {
  return profileById.get(candidateId);
}

export function personaForRole(roleId: string): HiringPersona {
  const role = getRoleOrDefault(roleId);
  return {
    jobTitle: role.title,
    wageMin: role.wageRange.min,
    wageMax: role.wageRange.max,
    dealbreakers: [...role.dealbreakers],
    niceToHaves: role.niceToHaveSkills.map(skill => skill.label.replace(/^\S+\s*/u, '')),
    storeLocation: '475 Central Ave, Jersey City, NJ 07307',
  };
}

export function createDemoPersonas(): Record<string, HiringPersona> {
  return Object.fromEntries(CAFE_ROLES.map(role => [role.id, personaForRole(role.id)]));
}

// These are illustrative pipeline stages, never inferred hiring decisions.
const INITIAL_STAGES: Record<string, CandidateStatus> = {
  'SYN-CAND-001': 'invited',
  'SYN-CAND-003': 'interviewed',
  'SYN-CAND-006': 'hired',
};

export function createDemoCandidates(): CandidateWithStatus[] {
  return SYNTHETIC_CANDIDATE_CORPUS.map(profile => ({
    id: profile.candidateRef,
    status: INITIAL_STAGES[profile.candidateRef] ?? 'new',
    data: {
      candidate: {
        name: profile.displayName,
        city: profile.location,
        skills: [...profile.skills],
        experience_years: profile.yearsExperience,
        applied_role: profile.roleId,
      },
      // Preserve the connected-candidate contract without inventing a sample fit score.
      // Synthetic cards, statistics, sorting, and filters never present this placeholder.
      score: {
        total: 0,
        breakdown: { constraints: 0, experience: 0, logistics: 0 },
        explanation: 'Fictional profile. Review its source evidence in Smart Search.',
      },
      red_flags: [],
    },
  }));
}

const criterionSchema = z.string().trim().min(1).max(200);
const personaSchema = z.object({
  jobTitle: z.string().min(1).max(100),
  wageMin: z.number().finite().min(0).max(1_000),
  wageMax: z.number().finite().min(0).max(1_000),
  dealbreakers: z.array(criterionSchema).max(20),
  niceToHaves: z.array(criterionSchema).max(20),
  storeLocation: z.string().max(300),
}).refine(persona => persona.wageMax >= persona.wageMin);

const statusSchema = z.enum(['pending', 'new', 'invited', 'interviewed', 'hired']);
const workspaceSchema = z.object({
  version: z.literal(1),
  statuses: z.record(z.string(), statusSchema),
  removedIds: z.array(z.string()).max(8),
  personas: z.record(z.string(), personaSchema),
});

export type DemoWorkspaceState = z.infer<typeof workspaceSchema>;

export function parseDemoWorkspace(raw: string | null): DemoWorkspaceState | null {
  if (!raw || raw.length > 80_000) return null;
  try {
    const parsed = workspaceSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return {
      version: 1,
      statuses: Object.fromEntries(Object.entries(parsed.data.statuses).filter(([id]) => isDemoCandidateId(id))),
      removedIds: [...new Set(parsed.data.removedIds.filter(isDemoCandidateId))],
      personas: Object.fromEntries(Object.entries(parsed.data.personas)
        .filter(([roleId]) => roleIds.has(roleId))
        .map(([roleId, persona]) => [roleId, { ...persona, jobTitle: getRoleOrDefault(roleId).title }])),
    };
  } catch {
    return null;
  }
}

export function restoreDemoCandidates(saved: DemoWorkspaceState | null): CandidateWithStatus[] {
  return createDemoCandidates()
    .filter(candidate => !saved?.removedIds.includes(candidate.id))
    .map(candidate => ({ ...candidate, status: saved?.statuses[candidate.id] ?? candidate.status }));
}

export function serializeDemoWorkspace(
  candidates: readonly CandidateWithStatus[],
  personas: Record<string, HiringPersona>,
): string {
  // Persist canonical synthetic IDs/statuses and demo preferences only. Never store
  // names, contacts, uploaded résumés, analysis, or connected candidate records.
  const demoCandidates = candidates.filter(candidate => isDemoCandidateId(candidate.id));
  const presentIds = new Set(demoCandidates.map(candidate => candidate.id));
  const state = {
    version: 1 as const,
    statuses: Object.fromEntries(demoCandidates.map(candidate => [candidate.id, candidate.status])),
    removedIds: SYNTHETIC_CANDIDATE_CORPUS.filter(profile => !presentIds.has(profile.candidateRef)).map(profile => profile.candidateRef),
    personas,
  };
  const sanitized = parseDemoWorkspace(JSON.stringify(state));
  if (!sanitized) throw new Error('Invalid demo workspace preferences.');
  return JSON.stringify(sanitized);
}
