import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { EMBEDDING_DIMENSIONS, EmbeddingSchema } from '../lib/contracts/embedding.ts';

import {
  createDeadlineSignal,
  readBoundedJsonResponse,
} from '../lib/http/bounded-json.ts';

export { EMBEDDING_DIMENSIONS } from '../lib/contracts/embedding.ts';
const MODEL = 'gemini-embedding-001';
const MAX_INPUT_CHARACTERS = 8_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PROVIDER_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`;

export type BackfillOptions = {
  apply: boolean;
  limit: number;
  batchSize: number;
  delayMs: number;
  after: string | null;
  merchantId: string | null;
};

export type Candidate = { id: string; resume_text: string | null };
export type BackfillRepository = {
  assertMigrated(): Promise<void>;
  listPending(after: string | null, limit: number, merchantId: string | null): Promise<Candidate[]>;
  saveIfUnchanged(candidate: Candidate, embedding: number[]): Promise<boolean>;
};
type BackfillDependencies = {
  repository: BackfillRepository;
  embed: (text: string) => Promise<number[]>;
  sleep?: (ms: number) => Promise<void>;
};

export class BackfillError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'BackfillError';
  }
}

export function parseOptions(args: string[]): BackfillOptions {
  const options: BackfillOptions = {
    apply: false, limit: 100, batchSize: 20, delayMs: 1_000, after: null, merchantId: null,
  };
  const seen = new Set<string>();
  for (const arg of args) {
    const [name, value, extra] = arg.split('=');
    if (seen.has(name) || extra !== undefined) throw new BackfillError('invalid_arguments');
    seen.add(name);
    if (name === '--apply' || name === '--dry-run') {
      if (value !== undefined || (seen.has('--apply') && seen.has('--dry-run'))) {
        throw new BackfillError('invalid_arguments');
      }
      options.apply = name === '--apply';
    } else if (name === '--after' || name === '--merchant-id') {
      if (!value || !UUID.test(value.toLowerCase())) throw new BackfillError('invalid_arguments');
      if (name === '--after') options.after = value.toLowerCase();
      else options.merchantId = value.toLowerCase();
    } else {
      const bounds = {
        '--limit': [1, 10_000], '--batch-size': [1, 50], '--delay-ms': [0, 60_000],
      } as const;
      if (!(name in bounds) || value === undefined || !/^(0|[1-9][0-9]*)$/u.test(value)) {
        throw new BackfillError('invalid_arguments');
      }
      const [min, max] = bounds[name as keyof typeof bounds];
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < min || number > max) {
        throw new BackfillError('invalid_arguments');
      }
      if (name === '--limit') options.limit = number;
      else if (name === '--batch-size') options.batchSize = number;
      else options.delayMs = number;
    }
  }
  return options;
}

/** Match extraction.py's text[:8000], including Python's Unicode codepoint slicing. */
export function prepareEmbeddingText(text: string | null): { text: string; truncated: boolean } | null {
  if (text === null || text.trim().length === 0) return null;
  let result = '';
  let count = 0;
  for (const character of text) {
    if (count === MAX_INPUT_CHARACTERS) return { text: result, truncated: true };
    result += character;
    count += 1;
  }
  return { text: result, truncated: false };
}

export function validateEmbedding(value: unknown): number[] {
  const result = EmbeddingSchema.safeParse(value);
  if (!result.success) throw new BackfillError('invalid_embedding');
  return result.data;
}

async function requestJson(
  url: string | URL,
  init: RequestInit,
  maxBytes: number,
  errorCode: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const deadline = createDeadlineSignal(30_000);
  try {
    const response = await fetchImpl(url, {
      ...init, signal: deadline.signal, redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new BackfillError(errorCode);
    }
    return await readBoundedJsonResponse(response, maxBytes, { signal: deadline.signal });
  } catch {
    // Provider/REST error messages can contain request text or credentials.
    throw new BackfillError(errorCode);
  } finally {
    deadline.dispose();
  }
}

export function createGeminiEmbedder(apiKey: string, fetchImpl: typeof fetch = fetch) {
  if (!apiKey.trim() || apiKey === 'MOCK_KEY') throw new BackfillError('missing_google_api_key');
  return async (text: string): Promise<number[]> => {
    const payload = await requestJson(PROVIDER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify({
        model: `models/${MODEL}`,
        content: { parts: [{ text }] },
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: EMBEDDING_DIMENSIONS,
      }),
    }, 200_000, 'embedding_request_failed', fetchImpl) as { embedding?: { values?: unknown } } | null;
    return validateEmbedding(payload?.embedding?.values);
  };
}

export function createBackfillRepository(
  supabaseUrl: string,
  serviceKey: string,
  fetchImpl: typeof fetch = fetch,
): BackfillRepository {
  let base: URL;
  try {
    base = new URL(supabaseUrl);
  } catch {
    throw new BackfillError('invalid_supabase_url');
  }
  if (
    !serviceKey.trim() || base.username || base.password || base.search || base.hash
    || base.pathname !== '/'
    || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
  ) throw new BackfillError('invalid_supabase_configuration');

  const headers = {
    apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json',
  };
  return {
    async assertMigrated() {
      // A zero-row request verifies the preserved migration column without reading vectors.
      const url = new URL('/rest/v1/candidates', base);
      url.search = new URLSearchParams({ select: 'id,embedding_768', limit: '0' }).toString();
      const value = await requestJson(url, { headers }, 1_024, 'embedding_migration_required', fetchImpl);
      if (!Array.isArray(value) || value.length !== 0) throw new BackfillError('embedding_migration_required');
    },
    async listPending(after, limit, merchantId) {
      const url = new URL('/rest/v1/candidates', base);
      url.search = new URLSearchParams({
        select: 'id,resume_text', embedding: 'is.null', order: 'id.asc', limit: String(limit),
        ...(after ? { id: `gt.${after}` } : {}),
        ...(merchantId ? { merchant_id: `eq.${merchantId}` } : {}),
      }).toString();
      const value = await requestJson(url, { headers }, 12_000_000, 'candidate_read_failed', fetchImpl);
      if (!Array.isArray(value) || value.length > limit) throw new BackfillError('invalid_candidate_response');
      let previous = after ?? '';
      for (const item of value) {
        if (!item || typeof item.id !== 'string' || !UUID.test(item.id) || item.id <= previous
          || (item.resume_text !== null && typeof item.resume_text !== 'string')) {
          throw new BackfillError('invalid_candidate_response');
        }
        previous = item.id;
      }
      return value as Candidate[];
    },
    async saveIfUnchanged(candidate, embedding) {
      const value = await requestJson(new URL('/rest/v1/rpc/complete_candidate_embedding_backfill', base), {
        method: 'POST', headers,
        body: JSON.stringify({
          candidate_id: candidate.id,
          expected_resume_text: candidate.resume_text,
          new_embedding: validateEmbedding(embedding),
        }),
      }, 1_024, 'candidate_update_failed', fetchImpl);
      if (typeof value !== 'boolean') throw new BackfillError('invalid_update_response');
      return value;
    },
  };
}

export async function runBackfill(options: BackfillOptions, dependencies: BackfillDependencies) {
  const summary = {
    mode: options.apply ? 'apply' : 'dry-run',
    scanned: 0, eligible: 0, updated: 0, skippedEmpty: 0, conflicts: 0, truncated: 0,
    providerCalls: 0, resumeAfter: options.after, stopReason: 'limit', error: null as string | null,
  };
  const sleep = dependencies.sleep ?? (ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)));
  try {
    await dependencies.repository.assertMigrated();
    while (summary.scanned < options.limit) {
      const rows = await dependencies.repository.listPending(
        summary.resumeAfter, Math.min(options.batchSize, options.limit - summary.scanned), options.merchantId,
      );
      if (rows.length === 0) {
        summary.stopReason = 'end';
        break;
      }
      for (const row of rows) {
        summary.scanned += 1;
        const prepared = prepareEmbeddingText(row.resume_text);
        if (!prepared) summary.skippedEmpty += 1;
        else {
          summary.eligible += 1;
          if (prepared.truncated) summary.truncated += 1;
          if (options.apply) {
            if (summary.providerCalls > 0 && options.delayMs > 0) await sleep(options.delayMs);
            summary.providerCalls += 1;
            const embedding = validateEmbedding(await dependencies.embed(prepared.text));
            if (await dependencies.repository.saveIfUnchanged(row, embedding)) summary.updated += 1;
            else summary.conflicts += 1;
          }
        }
        summary.resumeAfter = row.id;
      }
    }
  } catch (error) {
    summary.stopReason = 'error';
    summary.error = error instanceof BackfillError ? error.code : 'backfill_failed';
  }
  return summary;
}

async function main() {
  if (process.argv.slice(2).includes('--help')) {
    console.log('Usage: node --experimental-strip-types scripts/backfill-candidate-embeddings.ts [--dry-run|--apply] [--limit=100] [--batch-size=20] [--delay-ms=1000] [--after=UUID] [--merchant-id=UUID]\nRequires NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY). --apply also requires GOOGLE_API_KEY. Dry run reads only; see docs/embedding-migration.md.');
    return;
  }
  try {
    const options = parseOptions(process.argv.slice(2));
    const repository = createBackfillRepository(
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? '',
    );
    const embed = options.apply
      ? createGeminiEmbedder(process.env.GOOGLE_API_KEY ?? '')
      : async () => { throw new BackfillError('dry_run_cannot_embed'); };
    const summary = await runBackfill(options, { repository, embed });
    console.log(JSON.stringify(summary));
    if (summary.error) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof BackfillError ? error.code : 'backfill_failed' }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
