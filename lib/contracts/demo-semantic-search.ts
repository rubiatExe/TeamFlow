import { z } from 'zod';

export const QUERY_MATCH_RETRIEVAL_WEIGHT_PERCENT = 35 as const;
export const QUERY_MATCH_CONCEPT_COVERAGE_WEIGHT_PERCENT = 65 as const;

export function queryConceptCoveragePercent(matched: number, recognized: number): number {
  if (recognized === 0) return 0;
  return Math.round((matched / recognized) * 100);
}

export function queryMatchScoreFromSignals(
  similarity: number,
  conceptCoveragePercent: number,
  recognizedConceptCount: number,
): number {
  const retrievalPercent = Math.max(0, Math.min(1, similarity)) * 100;
  if (recognizedConceptCount === 0) return Math.round(retrievalPercent);
  return Math.round(
    (
      retrievalPercent * QUERY_MATCH_RETRIEVAL_WEIGHT_PERCENT
      + conceptCoveragePercent * QUERY_MATCH_CONCEPT_COVERAGE_WEIGHT_PERCENT
    ) / 100,
  );
}

export const DemoSemanticSearchRequestSchema = z.object({
  query: z.string().min(3).max(280),
}).strict();

const DemoCitationSchema = z.object({
  citation_id: z.string().regex(/^CIT-SYN-[0-9]{3}-B[0-9]{2}$/u),
  source_block_id: z.string().regex(/^SYN-RES-[0-9]{3}-B[0-9]{2}$/u),
  document_label: z.literal('Synthetic resume'),
  location: z.string().min(1).max(80),
  exact_quote: z.string().min(1).max(500),
  similarity: z.number().min(-1).max(1),
}).strict();

const DemoSearchResultSchema = z.object({
  synthetic_candidate_ref: z.string().regex(/^SYN-CAND-[0-9]{3}$/u),
  display_name: z.string().min(1).max(80),
  headline: z.string().min(1).max(120),
  location: z.string().min(1).max(80),
  years_experience: z.number().int().min(0).max(40),
  skills: z.array(z.string().min(1).max(80)).min(1).max(12),
  evidence_topics: z.array(z.string().min(1).max(80)).min(1).max(8),
  rank: z.number().int().min(1).max(5),
  weighted_evidence_similarity: z.number().min(-1).max(1),
  query_concepts_recognized: z.number().int().min(0).max(32),
  query_concepts_matched: z.number().int().min(0).max(32),
  query_concept_coverage: z.number().int().min(0).max(100),
  query_match_score: z.number().int().min(0).max(100),
  citations: z.array(DemoCitationSchema).min(1).max(2),
}).strict().superRefine((result, context) => {
  if (result.query_concepts_matched > result.query_concepts_recognized) {
    context.addIssue({
      code: 'custom',
      path: ['query_concepts_matched'],
      message: 'query_concepts_matched must not exceed query_concepts_recognized',
    });
  }
  const expectedCoverage = queryConceptCoveragePercent(
    result.query_concepts_matched,
    result.query_concepts_recognized,
  );
  if (result.query_concept_coverage !== expectedCoverage) {
    context.addIssue({
      code: 'custom',
      path: ['query_concept_coverage'],
      message: `query_concept_coverage must equal the recognized concept ratio (${expectedCoverage})`,
    });
  }
  const expectedScore = queryMatchScoreFromSignals(
    result.weighted_evidence_similarity,
    result.query_concept_coverage,
    result.query_concepts_recognized,
  );
  if (result.query_match_score !== expectedScore) {
    context.addIssue({
      code: 'custom',
      path: ['query_match_score'],
      message: `query_match_score must equal the backend evidence rescore (${expectedScore})`,
    });
  }
});

const DemoRetrievalMetadataSchema = z.object({
  mode: z.enum(['live_embedding', 'deterministic_fallback']),
  model_id: z.enum(['gemini-embedding-001', 'teamflow-concept-vector-v1']),
  dimensions: z.number().int().positive().max(3_072),
  metric: z.literal('cosine_similarity'),
  query_task: z.literal('RETRIEVAL_QUERY'),
  document_task: z.literal('RETRIEVAL_DOCUMENT'),
  corpus: z.literal('synthetic'),
  threshold_applied: z.literal(false),
  candidate_aggregation: z.literal('top_two_blocks_75_25'),
}).strict();

const DemoQueryMatchScoringMetadataSchema = z.object({
  method: z.literal('query_evidence_rescore_v1'),
  evidence_scope: z.literal('returned_profile_and_citations'),
  rerank_scope: z.literal('retrieval_top_5'),
  retrieval_weight_percent: z.literal(QUERY_MATCH_RETRIEVAL_WEIGHT_PERCENT),
  concept_coverage_weight_percent: z.literal(QUERY_MATCH_CONCEPT_COVERAGE_WEIGHT_PERCENT),
  no_recognized_concepts: z.literal('retrieval_only'),
  calibrated: z.literal(false),
  threshold_applied: z.literal(false),
}).strict();

export const DemoSemanticSearchResponseSchema = z.object({
  request_id: z.uuid(),
  query: z.string().min(3).max(280),
  retrieval: DemoRetrievalMetadataSchema,
  scoring: DemoQueryMatchScoringMetadataSchema,
  results: z.array(DemoSearchResultSchema).max(5),
  result_count: z.number().int().min(0).max(5),
  corpus_size: z.number().int().min(1).max(100),
  latency_ms: z.number().int().min(0).max(60_000),
  generated_at: z.iso.datetime(),
  decision_status: z.literal('no_hiring_decision'),
  warnings: z.array(z.string().min(1).max(240)).min(1).max(6),
}).strict().superRefine((response, context) => {
  if (response.result_count !== response.results.length) {
    context.addIssue({
      code: 'custom',
      path: ['result_count'],
      message: 'result_count must match results.length',
    });
  }
  response.results.forEach((result, index) => {
    if (result.rank !== index + 1) {
      context.addIssue({
        code: 'custom',
        path: ['results', index, 'rank'],
        message: 'results must be returned in rank order',
      });
    }
    if (index > 0) {
      const previous = response.results[index - 1];
      const outOfRescoreOrder = previous.query_match_score < result.query_match_score;
      const outOfRetrievalTieOrder = (
        previous.query_match_score === result.query_match_score
        && previous.weighted_evidence_similarity < result.weighted_evidence_similarity
      );
      const outOfStableTieOrder = (
        previous.query_match_score === result.query_match_score
        && previous.weighted_evidence_similarity === result.weighted_evidence_similarity
        && previous.synthetic_candidate_ref.localeCompare(result.synthetic_candidate_ref) > 0
      );
      if (outOfRescoreOrder || outOfRetrievalTieOrder || outOfStableTieOrder) {
        context.addIssue({
          code: 'custom',
          path: ['results', index],
          message: 'results must be ordered by query rescore, retrieval similarity, and stable candidate ID',
        });
      }
    }
  });
});

export const DemoSemanticSearchErrorSchema = z.object({
  request_id: z.uuid(),
  error: z.object({
    code: z.enum([
      'invalid_request',
      'unsafe_query',
      'rate_limited',
      'search_unavailable',
    ]),
    message: z.string().min(1).max(240),
  }).strict(),
}).strict();

export type DemoSemanticSearchRequest = z.infer<typeof DemoSemanticSearchRequestSchema>;
export type DemoSemanticSearchResponse = z.infer<typeof DemoSemanticSearchResponseSchema>;
export type DemoSemanticSearchError = z.infer<typeof DemoSemanticSearchErrorSchema>;
export type DemoSearchResult = z.infer<typeof DemoSearchResultSchema>;
