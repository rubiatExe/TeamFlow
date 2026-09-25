import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createDemoCandidates,
  createDemoPersonas,
  getDemoProfile,
  isDemoCandidateId,
  parseDemoWorkspace,
  restoreDemoCandidates,
  serializeDemoWorkspace,
} from '../../lib/domain/demo-workspace.ts';
import { SYNTHETIC_CANDIDATE_CORPUS } from '../../lib/domain/demo-semantic-search-data.ts';
import { getRoleById } from '../../lib/domain/roles.ts';

test('the board uses exactly the search corpus identities, roles, and evidence without contacts', () => {
  const candidates = createDemoCandidates();
  assert.equal(candidates.length, SYNTHETIC_CANDIDATE_CORPUS.length);
  for (const profile of SYNTHETIC_CANDIDATE_CORPUS) {
    const candidate = candidates.find(item => item.id === profile.candidateRef);
    assert.ok(candidate);
    assert.equal(candidate.data.candidate.name, profile.displayName);
    assert.equal(candidate.data.candidate.applied_role, profile.roleId);
    assert.ok(getRoleById(profile.roleId));
    assert.deepEqual(candidate.data.candidate.skills, profile.skills);
    assert.equal(candidate.data.candidate.email, undefined);
    assert.equal(candidate.data.candidate.phone, undefined);
    assert.equal(getDemoProfile(candidate.id), profile);
  }
});

test('demo stages, removals, and pay/preferences survive a storage round trip', () => {
  const candidates = createDemoCandidates().filter(candidate => candidate.id !== 'SYN-CAND-001');
  candidates.find(candidate => candidate.id === 'SYN-CAND-002')!.status = 'invited';
  const personas = createDemoPersonas();
  personas.barista.wageMin = 21.5;
  personas.barista.wageMax = 27;
  personas.barista.dealbreakers = [];
  const saved = parseDemoWorkspace(serializeDemoWorkspace(candidates, personas));
  assert.ok(saved);
  assert.equal(saved.personas.barista.wageMin, 21.5);
  assert.deepEqual(saved.personas.barista.dealbreakers, []);
  assert.deepEqual(restoreDemoCandidates(saved), candidates);
});

test('storage excludes uploaded/connected records and canonical sample payload overrides', () => {
  const candidates = createDemoCandidates();
  const first = candidates[0];
  first.data.candidate.name = 'Untrusted replacement';
  first.data.candidate.email = 'person@example.com';
  first.data.score.explanation = 'private analysis';
  candidates.push({
    ...first,
    id: 'connected-record-id',
    data: { ...first.data, candidate: { ...first.data.candidate, name: 'Private Applicant' } },
  });
  const serialized = serializeDemoWorkspace(candidates, createDemoPersonas());
  for (const forbidden of ['Untrusted replacement', 'person@example.com', 'private analysis', 'Private Applicant', 'connected-record-id']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  const restored = restoreDemoCandidates(parseDemoWorkspace(serialized));
  assert.equal(restored[0].data.candidate.name, SYNTHETIC_CANDIDATE_CORPUS[0].displayName);
  assert.equal(restored.length, SYNTHETIC_CANDIDATE_CORPUS.length);
});

test('storage accepts only known IDs/roles and replaces tampered job titles', () => {
  const personas = createDemoPersonas();
  const saved = parseDemoWorkspace(JSON.stringify({
    version: 1,
    statuses: { 'SYN-CAND-002': 'hired', 'private-id': 'new', demo_untrusted: 'invited' },
    removedIds: ['private-id', 'SYN-CAND-003', 'SYN-CAND-003'],
    personas: {
      barista: { ...personas.barista, jobTitle: 'Forged title', privateField: 'discard me' },
      unknown_role: personas.barista,
    },
    candidatePayloads: [{ name: 'not persisted' }],
  }));
  assert.ok(saved);
  assert.deepEqual(saved.statuses, { 'SYN-CAND-002': 'hired' });
  assert.deepEqual(saved.removedIds, ['SYN-CAND-003']);
  assert.deepEqual(Object.keys(saved.personas), ['barista']);
  assert.deepEqual(saved.personas.barista, personas.barista);
  assert.equal('candidatePayloads' in saved, false);
  assert.equal(isDemoCandidateId('demo_untrusted'), false);
  assert.equal(getDemoProfile('private-id'), undefined);
});

test('malformed or unsupported saved state falls back to canonical defaults', () => {
  for (const raw of [null, '', '{', 'null', '[]', '{}', JSON.stringify({ version: 2, statuses: {}, removedIds: [], personas: {} }), 'x'.repeat(80_001)]) {
    assert.equal(parseDemoWorkspace(raw), null);
    assert.deepEqual(restoreDemoCandidates(parseDemoWorkspace(raw)), createDemoCandidates());
  }
});

test('the storage limit permits the maximum valid preferences for every role', () => {
  const personas = createDemoPersonas();
  for (const persona of Object.values(personas)) {
    persona.dealbreakers = Array.from({ length: 20 }, (_, index) => `${index}`.padEnd(200, 'x'));
    persona.niceToHaves = Array.from({ length: 20 }, (_, index) => `${index}`.padEnd(200, 'y'));
    persona.storeLocation = 's'.repeat(300);
  }
  const saved = parseDemoWorkspace(serializeDemoWorkspace(createDemoCandidates(), personas));
  assert.ok(saved);
  assert.deepEqual(saved.personas, personas);
});

test('out-of-bounds preference values and invalid statuses are rejected', () => {
  const persona = createDemoPersonas().barista;
  const wrap = (value: unknown) => JSON.stringify({ version: 1, statuses: {}, removedIds: [], personas: { barista: value } });
  for (const invalid of [
    { ...persona, wageMin: -1 },
    { ...persona, wageMin: 30, wageMax: 20 },
    { ...persona, wageMax: 1_001 },
    { ...persona, wageMax: '25' },
    { ...persona, wageMin: null },
    { ...persona, dealbreakers: [' '] },
    { ...persona, dealbreakers: ['a'.repeat(201)] },
    { ...persona, niceToHaves: Array(21).fill('criterion') },
    { ...persona, storeLocation: 'a'.repeat(301) },
  ]) {
    assert.equal(parseDemoWorkspace(wrap(invalid)), null);
  }
  assert.equal(parseDemoWorkspace(JSON.stringify({ version: 1, statuses: { 'SYN-CAND-002': 'invalid' }, removedIds: [], personas: {} })), null);
});

test('new workspace instances do not share mutable candidate or persona arrays', () => {
  const candidates = createDemoCandidates();
  candidates[0].data.candidate.skills.push('Local edit');
  candidates[0].status = 'pending';
  assert.equal(createDemoCandidates()[0].data.candidate.skills.includes('Local edit'), false);
  assert.notEqual(createDemoCandidates()[0].status, 'pending');
  const personas = createDemoPersonas();
  personas.barista.dealbreakers.length = 0;
  assert.ok(createDemoPersonas().barista.dealbreakers.length > 0);
});
