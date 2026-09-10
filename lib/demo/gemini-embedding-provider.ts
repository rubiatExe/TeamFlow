import {
  createDeadlineSignal,
  readBoundedJsonResponse,
} from '../http/bounded-json.ts';
import { withTraceSpan } from '../observability/tracing.ts';
import {
  sourceBlockEmbeddingText,
  type SourceBlockVector,
} from './semantic-search-core.ts';
import { SYNTHETIC_CANDIDATE_CORPUS } from '../domain/demo-semantic-search-data.ts';

const MODEL_ID = 'gemini-embedding-001';
const MODEL_RESOURCE = `models/${MODEL_ID}`;
const EMBEDDING_DIMENSIONS = 768;
const EMBEDDING_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:batchEmbedContents`;
const EMBEDDING_DEADLINE_MS = 8_000;
const MAX_EMBEDDING_RESPONSE_BYTES = 2_000_000;
const MAX_BATCH_ITEMS = 8;
const MAX_TOTAL_ITEMS = 32;

type RetrievalTask = 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT';
type EmbeddingFetch = typeof fetch;

type EmbeddingResponse = {
  embeddings?: Array<{ values?: unknown }>;
};

type TraceableRequestInit = RequestInit & {
  opentelemetry?: {
    propagateContext?: boolean;
    spanName?: string;
  };
};

export class GeminiEmbeddingUnavailableError extends Error {
  constructor() {
    super('Gemini embedding service is unavailable');
    this.name = 'GeminiEmbeddingUnavailableError';
  }
}

export function publicLiveEmbeddingsEnabled(): boolean {
  return process.env.TEAMFLOW_PUBLIC_DEMO_LIVE_EMBEDDINGS === 'true';
}

function configuredApiKey(): string | null {
  if (!publicLiveEmbeddingsEnabled()) return null;
  const value = process.env.GOOGLE_API_KEY?.trim();
  return value && value !== 'MOCK_KEY' ? value : null;
}

function parseEmbeddingResponse(value: unknown, expectedCount: number): number[][] {
  const response = value as EmbeddingResponse;
  if (!Array.isArray(response?.embeddings) || response.embeddings.length !== expectedCount) {
    throw new GeminiEmbeddingUnavailableError();
  }
  return response.embeddings.map(item => {
    if (!Array.isArray(item.values) || item.values.length !== EMBEDDING_DIMENSIONS) {
      throw new GeminiEmbeddingUnavailableError();
    }
    const vector = item.values.map(component => (
      typeof component === 'number' ? component : Number.NaN
    ));
    if (
      vector.some(component => !Number.isFinite(component))
      || !vector.some(component => component !== 0)
    ) {
      throw new GeminiEmbeddingUnavailableError();
    }
    return vector;
  });
}

async function embedTextBatch(
  texts: readonly string[],
  taskType: RetrievalTask,
  fetchImpl: EmbeddingFetch = fetch,
): Promise<number[][]> {
  const apiKey = configuredApiKey();
  if (!apiKey || texts.length < 1 || texts.length > MAX_BATCH_ITEMS) {
    throw new GeminiEmbeddingUnavailableError();
  }

  const deadline = createDeadlineSignal(EMBEDDING_DEADLINE_MS);
  const requestOptions: TraceableRequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
    },
    body: JSON.stringify({
      requests: texts.map(text => ({
        model: MODEL_RESOURCE,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: EMBEDDING_DIMENSIONS,
      })),
    }),
    cache: 'no-store',
    redirect: 'error',
    signal: deadline.signal,
    opentelemetry: {
      // Query text must not be propagated to a third-party span exporter.
      propagateContext: false,
      spanName: 'demo.embedding.batch',
    },
  };

  try {
    const response = await fetchImpl(EMBEDDING_ENDPOINT, requestOptions);
    if (!response.ok) throw new GeminiEmbeddingUnavailableError();
    const payload = await readBoundedJsonResponse(
      response,
      MAX_EMBEDDING_RESPONSE_BYTES,
      { signal: deadline.signal },
    );
    return parseEmbeddingResponse(payload, texts.length);
  } catch (error) {
    if (error instanceof GeminiEmbeddingUnavailableError) throw error;
    throw new GeminiEmbeddingUnavailableError();
  } finally {
    deadline.dispose();
  }
}

async function embedTexts(
  texts: readonly string[],
  taskType: RetrievalTask,
  fetchImpl: EmbeddingFetch = fetch,
): Promise<number[][]> {
  if (texts.length < 1 || texts.length > MAX_TOTAL_ITEMS) {
    throw new GeminiEmbeddingUnavailableError();
  }
  const batches: string[][] = [];
  for (let offset = 0; offset < texts.length; offset += MAX_BATCH_ITEMS) {
    batches.push(texts.slice(offset, offset + MAX_BATCH_ITEMS));
  }
  const vectors = await Promise.all(
    batches.map(batch => embedTextBatch(batch, taskType, fetchImpl)),
  );
  return vectors.flat();
}

const sourcePayloads = SYNTHETIC_CANDIDATE_CORPUS.flatMap(candidate => (
  candidate.sourceBlocks.map(sourceBlock => ({
    sourceBlockId: sourceBlock.sourceBlockId,
    text: sourceBlockEmbeddingText(sourceBlock),
  }))
));

let cachedSourceVectors: Promise<SourceBlockVector[]> | null = null;

async function getSourceVectors(fetchImpl: EmbeddingFetch = fetch): Promise<SourceBlockVector[]> {
  if (fetchImpl !== fetch) {
    const vectors = await embedTexts(
      sourcePayloads.map(payload => payload.text),
      'RETRIEVAL_DOCUMENT',
      fetchImpl,
    );
    return sourcePayloads.map((payload, index) => ({
      sourceBlockId: payload.sourceBlockId,
      values: vectors[index],
    }));
  }

  if (!cachedSourceVectors) {
    cachedSourceVectors = embedTexts(
      sourcePayloads.map(payload => payload.text),
      'RETRIEVAL_DOCUMENT',
      fetchImpl,
    ).then(vectors => sourcePayloads.map((payload, index) => ({
      sourceBlockId: payload.sourceBlockId,
      values: vectors[index],
    }))).catch(error => {
      cachedSourceVectors = null;
      throw error;
    });
  }
  return cachedSourceVectors;
}

export type GeminiSemanticVectors = {
  queryVector: number[];
  sourceVectors: SourceBlockVector[];
  modelId: typeof MODEL_ID;
  dimensions: typeof EMBEDDING_DIMENSIONS;
};

export async function getGeminiSemanticVectors(
  query: string,
  dependencies: { fetchImpl?: EmbeddingFetch } = {},
): Promise<GeminiSemanticVectors> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  return withTraceSpan(
    'demo.semantic_search.embed',
    {
      'teamflow.ai.operation': 'embedding',
      'gen_ai.request.model': MODEL_ID,
      'teamflow.embedding.dimensions': EMBEDDING_DIMENSIONS,
      'teamflow.embedding.corpus': 'synthetic',
      'teamflow.embedding.document_count': sourcePayloads.length,
    },
    async () => {
      const [queryEmbeddings, sourceVectors] = await Promise.all([
        embedTexts([query], 'RETRIEVAL_QUERY', fetchImpl),
        getSourceVectors(fetchImpl),
      ]);
      return {
        queryVector: queryEmbeddings[0],
        sourceVectors,
        modelId: MODEL_ID,
        dimensions: EMBEDDING_DIMENSIONS,
      };
    },
  );
}
