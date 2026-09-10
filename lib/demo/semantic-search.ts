import {
  DemoSemanticSearchResponseSchema,
  type DemoSemanticSearchResponse,
} from '../contracts/demo-semantic-search.ts';
import { SYNTHETIC_CANDIDATE_CORPUS } from '../domain/demo-semantic-search-data.ts';
import { withTraceSpan } from '../observability/tracing.ts';
import {
  GeminiEmbeddingUnavailableError,
  getGeminiSemanticVectors,
  publicLiveEmbeddingsEnabled,
  type GeminiSemanticVectors,
} from './gemini-embedding-provider.ts';
import {
  CONCEPT_VECTOR_DIMENSIONS,
  assertLiteralSourceCitations,
  createConceptVector,
  createFallbackSourceVectors,
  inspectDemoSearchQuery,
  rankSyntheticCandidates,
  validateSyntheticCorpus,
} from './semantic-search-core.ts';

export class DemoSearchValidationError extends Error {
  readonly code: 'invalid_request' | 'unsafe_query';

  constructor(code: 'invalid_request' | 'unsafe_query', message: string) {
    super(message);
    this.name = 'DemoSearchValidationError';
    this.code = code;
  }
}

type SearchDependencies = {
  getGeminiVectors?: (query: string) => Promise<GeminiSemanticVectors>;
  now?: () => number;
  isoNow?: () => string;
  logProviderFallback?: () => void;
  liveEmbeddingEnabled?: boolean;
};

validateSyntheticCorpus();

export async function searchSyntheticCandidates(
  rawQuery: string,
  requestId: string,
  dependencies: SearchDependencies = {},
): Promise<DemoSemanticSearchResponse> {
  const inspected = inspectDemoSearchQuery(rawQuery);
  if (!inspected.ok) {
    throw new DemoSearchValidationError(inspected.code, inspected.message);
  }

  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  return withTraceSpan(
    'demo.semantic_search',
    {
      'teamflow.search.corpus': 'synthetic',
      'teamflow.search.corpus_size': SYNTHETIC_CANDIDATE_CORPUS.length,
      'teamflow.search.limit': 5,
      'teamflow.search.threshold_applied': false,
    },
    async () => {
      let retrieval: DemoSemanticSearchResponse['retrieval'];
      let results: DemoSemanticSearchResponse['results'];
      let providerFallback = false;
      let liveEmbeddingDisabled = false;

      try {
        const liveEmbeddingEnabled = dependencies.liveEmbeddingEnabled
          ?? publicLiveEmbeddingsEnabled();
        if (!liveEmbeddingEnabled) {
          liveEmbeddingDisabled = true;
          throw new GeminiEmbeddingUnavailableError();
        }
        const vectors = await (dependencies.getGeminiVectors ?? getGeminiSemanticVectors)(inspected.query);
        results = rankSyntheticCandidates(
          vectors.queryVector,
          vectors.sourceVectors,
          5,
        );
        retrieval = {
          mode: 'live_embedding',
          model_id: vectors.modelId,
          dimensions: vectors.dimensions,
          metric: 'cosine_similarity',
          query_task: 'RETRIEVAL_QUERY',
          document_task: 'RETRIEVAL_DOCUMENT',
          corpus: 'synthetic',
          threshold_applied: false,
          candidate_aggregation: 'top_two_blocks_75_25',
        };
      } catch (error) {
        if (!(error instanceof GeminiEmbeddingUnavailableError)) throw error;
        providerFallback = true;
        if (!liveEmbeddingDisabled) {
          (dependencies.logProviderFallback ?? (() => {
            console.warn('[Demo Search] Embedding provider unavailable; using deterministic fallback');
          }))();
        }
        results = rankSyntheticCandidates(
          createConceptVector(inspected.query),
          createFallbackSourceVectors(),
          5,
        );
        retrieval = {
          mode: 'deterministic_fallback',
          model_id: 'teamflow-concept-vector-v1',
          dimensions: CONCEPT_VECTOR_DIMENSIONS,
          metric: 'cosine_similarity',
          query_task: 'RETRIEVAL_QUERY',
          document_task: 'RETRIEVAL_DOCUMENT',
          corpus: 'synthetic',
          threshold_applied: false,
          candidate_aggregation: 'top_two_blocks_75_25',
        };
      }

      assertLiteralSourceCitations(results);
      const latencyMs = Math.max(0, Math.min(60_000, Math.round(now() - startedAt)));
      return DemoSemanticSearchResponseSchema.parse({
        request_id: requestId,
        query: inspected.query,
        retrieval,
        results,
        result_count: results.length,
        corpus_size: SYNTHETIC_CANDIDATE_CORPUS.length,
        latency_ms: latencyMs,
        generated_at: (dependencies.isoNow ?? (() => new Date().toISOString()))(),
        decision_status: 'no_hiring_decision',
        warnings: [
          'Synthetic portfolio records only; no real applicants or contact details are searched.',
          'Weighted evidence similarity combines the top two block-level cosine values; it is not candidate quality, fit, confidence, or a hiring recommendation.',
          'No acceptance threshold or automated hiring decision is applied.',
          ...(providerFallback
            ? [liveEmbeddingDisabled
              ? 'Live Gemini embeddings are disabled for this public deployment, so this response used the labeled deterministic concept-vector fallback.'
              : 'Gemini embeddings were unavailable, so this response used the labeled deterministic concept-vector fallback.']
            : []),
        ],
      });
    },
  );
}
