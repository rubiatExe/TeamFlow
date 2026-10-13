import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BackfillError,
  createBackfillRepository,
  createGeminiEmbedder,
  EMBEDDING_DIMENSIONS,
  parseOptions,
  prepareEmbeddingText,
  runBackfill,
  validateEmbedding,
  type BackfillRepository,
  type Candidate,
} from '../../scripts/backfill-candidate-embeddings.ts';

const id = (number: number) => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const vector = () => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01);
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});

function inMemoryRepository(rows: Array<Candidate & { embedding?: number[] }>) {
  const writes: string[] = [];
  const repository: BackfillRepository = {
    async assertMigrated() {},
    async listPending(after, limit) {
      return rows.filter(row => !row.embedding && (!after || row.id > after))
        .slice(0, limit).map(row => ({ id: row.id, resume_text: row.resume_text }));
    },
    async saveIfUnchanged(candidate, embedding) {
      const row = rows.find(item => item.id === candidate.id);
      if (!row || row.embedding || row.resume_text !== candidate.resume_text) return false;
      row.embedding = embedding;
      writes.push(row.id);
      return true;
    },
  };
  return { repository, writes };
}

test('arguments default to a bounded dry run and reject accidental unbounded options', () => {
  assert.deepEqual(parseOptions([]), {
    apply: false, limit: 100, batchSize: 20, delayMs: 1_000, after: null, merchantId: null,
  });
  assert.deepEqual(parseOptions(['--apply', '--limit=2', '--batch-size=1', '--delay-ms=0', `--after=${id(3)}`]), {
    apply: true, limit: 2, batchSize: 1, delayMs: 0, after: id(3), merchantId: null,
  });
  for (const args of [
    ['--apply', '--dry-run'], ['--limit=0'], ['--limit=10001'], ['--batch-size=51'],
    ['--limit=1e3'], ['--delay-ms=-1'], ['--after=bad'], ['--force'],
    ['--apply=true'], ['--limit=2', '--limit=3'],
  ]) assert.throws(() => parseOptions(args), BackfillError);
});

test('uses the exact canonical text prefix with Python Unicode slicing semantics', () => {
  assert.equal(prepareEmbeddingText(null), null);
  assert.equal(prepareEmbeddingText(' \n\t'), null);
  assert.deepEqual(prepareEmbeddingText('  Canonical\r\nresume  '), {
    text: '  Canonical\r\nresume  ', truncated: false,
  });
  const prefix = '😀'.repeat(7_999) + 'A';
  assert.deepEqual(prepareEmbeddingText(prefix + 'tail'), { text: prefix, truncated: true });
  assert.deepEqual(prepareEmbeddingText(prefix), { text: prefix, truncated: false });
});

test('requires 3072 finite components that remain a nonzero halfvec', () => {
  assert.equal(validateEmbedding(vector()).length, 3_072);
  for (const invalid of [
    Array(768).fill(0.01), Array(3_072).fill(0), Array(3_072).fill(1e-30),
    [...vector().slice(1), Infinity], [...vector().slice(1), '0.1'],
    [...vector().slice(1), 65_505],
  ]) assert.throws(() => validateEmbedding(invalid), BackfillError);
});

test('dry run reads missing vectors while making zero provider calls or writes', async () => {
  const { repository, writes } = inMemoryRepository([
    { id: id(1), resume_text: 'existing', embedding: vector() },
    { id: id(2), resume_text: null },
    { id: id(3), resume_text: ' \n' },
    { id: id(4), resume_text: 'x'.repeat(8_001) },
  ]);
  const result = await runBackfill(parseOptions(['--batch-size=1']), {
    repository, embed: async () => { assert.fail('dry run called provider'); },
  });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.scanned, 3);
  assert.equal(result.eligible, 1);
  assert.equal(result.skippedEmpty, 2);
  assert.equal(result.truncated, 1);
  assert.equal(result.providerCalls, 0);
  assert.equal(result.stopReason, 'end');
  assert.deepEqual(writes, []);
});

test('apply paginates without offset gaps, bounds calls, and resumes idempotently', async () => {
  const rows = [1, 2, 3, 4].map(number => ({ id: id(number), resume_text: `resume ${number}` }));
  const { repository, writes } = inMemoryRepository(rows);
  const calls: string[] = [];
  const sleeps: number[] = [];
  const dependencies = {
    repository,
    embed: async (text: string) => { calls.push(text); return vector(); },
    sleep: async (ms: number) => { sleeps.push(ms); },
  };
  const first = await runBackfill(parseOptions(['--apply', '--limit=2', '--batch-size=1']), dependencies);
  assert.equal(first.updated, 2);
  assert.equal(first.resumeAfter, id(2));
  assert.equal(first.stopReason, 'limit');
  const second = await runBackfill(parseOptions(['--apply', `--after=${first.resumeAfter}`]), dependencies);
  assert.equal(second.updated, 2);
  const repeated = await runBackfill(parseOptions(['--apply']), dependencies);
  assert.equal(repeated.providerCalls, 0);
  assert.deepEqual(writes, [id(1), id(2), id(3), id(4)]);
  assert.deepEqual(calls, ['resume 1', 'resume 2', 'resume 3', 'resume 4']);
  assert.deepEqual(sleeps, [1_000, 1_000]);
});

test('stops on a provider failure and preserves a cursor before the failed row', async () => {
  const { repository, writes } = inMemoryRepository([
    { id: id(1), resume_text: 'first' }, { id: id(2), resume_text: 'private resume' },
  ]);
  const result = await runBackfill(parseOptions(['--apply', '--delay-ms=0']), {
    repository,
    embed: async (text: string) => {
      if (text === 'private resume') throw new Error('private resume and secret key');
      return vector();
    },
  });
  assert.deepEqual(writes, [id(1)]);
  assert.equal(result.resumeAfter, id(1));
  assert.equal(result.stopReason, 'error');
  assert.equal(result.error, 'backfill_failed');
  assert.doesNotMatch(JSON.stringify(result), /private resume|secret key/u);
});

test('never overwrites a concurrent resume edit or a newly completed embedding', async () => {
  const rows: Array<Candidate & { embedding?: number[] }> = [
    { id: id(1), resume_text: 'old resume' }, { id: id(2), resume_text: 'same resume' },
  ];
  const { repository, writes } = inMemoryRepository(rows);
  const result = await runBackfill(parseOptions(['--apply', '--delay-ms=0']), {
    repository,
    embed: async (text: string) => {
      if (text === 'old resume') rows[0].resume_text = 'new resume';
      else rows[1].embedding = Array(3_072).fill(0.02);
      return vector();
    },
  });
  assert.equal(result.conflicts, 2);
  assert.deepEqual(writes, []);
  assert.equal(rows[0].embedding, undefined);
  assert.equal(rows[1].embedding?.[0], 0.02);
});

test('Gemini request uses retrieval documents and rejects bad data without exposing it', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const embed = createGeminiEmbedder('test-secret', async (url, init) => {
    requests.push({ url: String(url), init });
    return json({ embedding: { values: vector() } });
  });
  assert.equal((await embed('canonical resume')).length, 3_072);
  const request = requests[0];
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent');
  assert.equal(new Headers(request.init?.headers).get('X-Goog-Api-Key'), 'test-secret');
  assert.equal(request.init?.redirect, 'error');
  assert.ok(request.init?.signal);
  assert.deepEqual(JSON.parse(String(request.init?.body)), {
    model: 'models/gemini-embedding-001', content: { parts: [{ text: 'canonical resume' }] },
    taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 3_072,
  });
  await assert.rejects(createGeminiEmbedder('test-secret', async () => json({
    error: 'canonical resume and test-secret',
  }, 429))('canonical resume'), { message: 'embedding_request_failed' });
  await assert.rejects(createGeminiEmbedder('test-secret', async () => json({
    embedding: { values: Array(768).fill(1) },
  }))('canonical resume'), { message: 'invalid_embedding' });
});

test('REST reads only pending rows and sends conditional update text in a POST body', async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const responses = [json([]), json([{ id: id(2), resume_text: 'sensitive & resume' }]), json(false)];
  const repository = createBackfillRepository('https://example.supabase.co', 'service-secret', async (url, init) => {
    requests.push({ url: new URL(String(url)), init });
    return responses.shift()!;
  });
  await repository.assertMigrated();
  const [candidate] = await repository.listPending(id(1), 5, id(20));
  assert.equal(await repository.saveIfUnchanged(candidate, vector()), false);
  assert.equal(requests[0].url.searchParams.get('select'), 'id,embedding_768');
  assert.equal(requests[0].url.searchParams.get('limit'), '0');
  assert.equal(requests[1].url.searchParams.get('embedding'), 'is.null');
  assert.equal(requests[1].url.searchParams.get('id'), `gt.${id(1)}`);
  assert.equal(requests[1].url.searchParams.get('merchant_id'), `eq.${id(20)}`);
  assert.equal(requests[2].url.pathname, '/rest/v1/rpc/complete_candidate_embedding_backfill');
  assert.equal(requests[2].url.search, '');
  assert.equal(requests[2].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[2].init?.body)), {
    candidate_id: id(2), expected_resume_text: 'sensitive & resume', new_embedding: vector(),
  });
  assert.ok(requests.every(request => !String(request.url).includes('service-secret')));
});

test('migration preflight failure prevents provider requests', async () => {
  const repository = createBackfillRepository('http://127.0.0.1:54321', 'service-secret', async () => json({
    error: 'column missing',
  }, 400));
  const result = await runBackfill(parseOptions(['--apply']), {
    repository, embed: async () => { assert.fail('provider called before migration'); },
  });
  assert.equal(result.error, 'embedding_migration_required');
  assert.equal(result.providerCalls, 0);
});
