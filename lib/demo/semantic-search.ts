import {
  DemoSemanticSearchResponseSchema,
  QUERY_MATCH_CONCEPT_COVERAGE_WEIGHT_PERCENT,
  QUERY_MATCH_RETRIEVAL_WEIGHT_PERCENT,
  type DemoSemanticSearchResponse,
  type DemoSearchScope,
} from '../contracts/demo-semantic-search.ts';
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
  assertQueryEvidenceRescores,
  createConceptVector,
  createFallbackSourceVectors,
  inspectDemoSearchQuery,
  rankSyntheticCandidates,
  scopedSyntheticCandidates,
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
  scope: DemoSearchScope = {},
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
      'teamflow.search.corpus_size': scopedSyntheticCandidates(scope).length,
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
          inspected.query,
          vectors.queryVector,
          vectors.sourceVectors,
          5,
          scope,
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
          candidate_aggregation: 'query_covering_two_blocks_75_25',
          relevance_filter: 'positive_concept_or_token_overlap',
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
          inspected.query,
          createConceptVector(inspected.query),
          createFallbackSourceVectors(),
          5,
          scope,
        );
        retrieval = {
          mode: 'deterministic_fallback',
          model_id: 'teamflow-concept-vector-v2',
          dimensions: CONCEPT_VECTOR_DIMENSIONS,
          metric: 'cosine_similarity',
          query_task: 'RETRIEVAL_QUERY',
          document_task: 'RETRIEVAL_DOCUMENT',
          corpus: 'synthetic',
          threshold_applied: false,
          candidate_aggregation: 'query_covering_two_blocks_75_25',
          relevance_filter: 'positive_concept_or_token_overlap',
        };
      }

      assertLiteralSourceCitations(results);
      assertQueryEvidenceRescores(inspected.query, results);
      const latencyMs = Math.max(0, Math.min(60_000, Math.round(now() - startedAt)));
      return DemoSemanticSearchResponseSchema.parse({
        request_id: requestId,
        query: inspected.query,
        retrieval,
        scoring: {
          method: 'query_evidence_rescore_v2',
          evidence_scope: 'returned_profile_and_citations',
          rerank_scope: 'retrieval_top_5',
          retrieval_weight_percent: QUERY_MATCH_RETRIEVAL_WEIGHT_PERCENT,
          concept_coverage_weight_percent: QUERY_MATCH_CONCEPT_COVERAGE_WEIGHT_PERCENT,
          no_recognized_concepts: 'retrieval_only',
          calibrated: false,
          threshold_applied: false,
        },
        results,
        result_count: results.length,
        corpus_size: scopedSyntheticCandidates(scope).length,
        latency_ms: latencyMs,
        generated_at: (dependencies.isoNow ?? (() => new Date().toISOString()))(),
        decision_status: 'no_hiring_decision',
        warnings: [
          'This demo searches only fictional résumé profiles; no real applicants or contact details are included.',
          'The list order compares only job-related wording in the returned fictional profile and résumé quotations. It does not measure applicant quality or recommend who to hire.',
          'TeamFlow does not accept or reject anyone, and it does not apply a pass line.',
          'Query match is an uncalibrated blend of visible job-concept coverage and retrieval relevance. It is not a fit score or hiring recommendation.',
          ...(providerFallback
            ? [liveEmbeddingDisabled
              ? 'Google-powered matching is off for this demo, so this search used TeamFlow’s built-in matching.'
              : 'Google-powered matching was unavailable, so this search used TeamFlow’s built-in matching.']
            : []),
        ],
      });
    },
  );
}
