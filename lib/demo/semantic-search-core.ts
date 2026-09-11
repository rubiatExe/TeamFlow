import type { DemoSearchResult } from '../contracts/demo-semantic-search.ts';
import {
  SYNTHETIC_CANDIDATE_CORPUS,
  type SyntheticCandidateProfile,
  type SyntheticSourceBlock,
} from '../domain/demo-semantic-search-data.ts';

const CANDIDATE_CORPUS: readonly SyntheticCandidateProfile[] = SYNTHETIC_CANDIDATE_CORPUS;

const PROTECTED_OR_MEDICAL_TRAIT = /\b(?:age|race|racial|ethnicity|ethnic|gender|woman|women|man|men|female|male|transgender|non[ -]?binary|cisgender|religion|religious|christian|muslim|jewish|hindu|buddhist|sikh|atheist|national origin|citizenship|native english|mother tongue|accent|pregnan(?:t|cy)|marital status|sexual orientation|gay|lesbian|bisexual|queer|straight|disability|disabled|veteran|military status|genetic information|date of birth|born|diagnos(?:is|ed)|disease|medical condition|medication|mental health|medical history)\b/iu;
const CONTEXTUAL_IDENTITY_TRAIT = /\b(?:(?:young|younger|older|elderly|black|white|asian|caucasian|hispanic|latin[oa]|latinx|indigenous|arab|middle eastern|native american|pacific islander|single|married)\s+(?:candidate|applicant|worker|employee|person|barista|baker|cook|chef|server|associate|supervisor|manager|shift leader)|(?:candidate|applicant|worker|employee|person|barista|baker|cook|chef|server|associate|supervisor|manager|shift leader)\s+(?:who\s+is\s+|that\s+is\s+|is\s+)?(?:young|younger|older|elderly|black|white|asian|caucasian|hispanic|latin[oa]|latinx|indigenous|arab|middle eastern|native american|pacific islander|single|married))\b/iu;
const AGE_PROXY = /\b(?:(?:(?:younger|older)\s+than\s+\d{1,3})|(?:(?:under|over)\s+\d{1,3}\s*(?:years?\s*old|y[./]?o[.]?|candidate|applicant|worker|employee|person|someone|barista|baker|cook|chef|server|associate|supervisor|manager))|(?:(?:candidate|applicant|worker|employee|person|someone|barista|baker|cook|chef|server|associate|supervisor|manager)\s+(?:under|over)\s+\d{1,3})|(?:\d{1,3}(?:\s+|-)years?(?:\s+|-)old)|(?:\d{1,3}\s*y[./]?o[.]?)|(?:gen(?:eration)?\s*[xyz]|millennial|boomer))\b/iu;
const CONTACT_OR_SECRET = /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?<!\d)(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?!\d)|\bhttps?:\/\/\S+|\b\d{1,6}\s+(?:[\p{L}0-9.'-]+\s+){0,4}(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl)\b|\b(?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|password|secret|credential)s?\b)/iu;
const DATABASE_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
const DECISION_OR_MANIPULATION = /(?:\b(?:hire|reject|disqualify|screen out)\b|\b(?:fit|candidate|hiring)\s*score\b|\b(?:best|worst)\s+candidate\b|\b(?:ignore|disregard|override|forget)\b.{0,60}\b(?:instruction|prompt|policy|rule)s?\b|\b(?:system|developer)\s+(?:message|prompt|instruction)s?\s*:)/iu;
const NON_PRINTING = /[\u0000-\u001f\u007f\u200b-\u200f\u2060\ufeff]/u;

const CONCEPTS = [
  ['coffee service', ['barista', 'coffee', 'cafe', 'espresso', 'milk drinks']],
  ['training', ['train', 'trained', 'trainer', 'training', 'coach', 'coached', 'mentor', 'onboard', 'onboarding', 'new hire']],
  ['leadership', ['lead', 'leader', 'leadership', 'supervise', 'supervised', 'supervisor', 'manager', 'managed', 'shift huddle']],
  ['weekend availability', ['weekend', 'weekends', 'saturday', 'sunday']],
  ['opening shifts', ['opening', 'opener', 'open shift', 'morning shift', 'early morning']],
  ['closing shifts', ['closing', 'closer', 'close shift', 'evening shift', 'night shift']],
  ['high-volume service', ['high volume', 'busy', 'rush', 'covers', 'transactions per shift', 'orders']],
  ['customer service', ['customer', 'guest', 'hospitality', 'service desk', 'guest recovery', 'de-escalate', 'deescalate']],
  ['pos systems', ['pos', 'point of sale', 'register', 'refund', 'transactions']],
  ['cash handling', ['cash', 'cash drawer', 'register variance', 'cash controls']],
  ['inventory', ['inventory', 'stock', 'stockout', 'cycle count', 'fifo', 'purchase order', 'variance report']],
  ['scheduling', ['schedule', 'scheduling', 'coverage', 'shift swap', 'forecast demand']],
  ['latte art', ['latte art', 'tulip', 'milk texture', 'drink presentation']],
  ['bakery', ['baker', 'bakery', 'baking', 'dough', 'bread', 'loaf', 'loaves', 'pastry']],
  ['sourdough', ['sourdough', 'fermentation', 'starter']],
  ['recipe scaling', ['recipe scaling', 'scale recipes', 'scaled formulas', 'batch', 'batches', 'yield']],
  ['oven operations', ['oven', 'deck oven', 'bake', 'baked']],
  ['food safety', ['food safety', 'food handler', 'servsafe', 'sanitation', 'holding temperature', 'cold chain']],
  ['line cooking', ['line cook', 'grill', 'saute', 'expo', 'ticket timing']],
  ['knife skills', ['knife', 'knife prep', 'portion', 'portioned']],
  ['food prep', ['food prep', 'prep', 'ingredient', 'protein']],
  ['teamwork', ['teamwork', 'team', 'handoff', 'communicating', 'communication']],
  ['conflict resolution', ['conflict', 'de-escalated', 'deescalated', 'resolved concerns', 'guest concerns']],
  ['retail', ['retail', 'exchange', 'service desk', 'holiday retail']],
  ['event service', ['event', 'registration', 'attendees', 'room reset']],
  ['entry level', ['entry level', 'first cafe role', 'new to', 'eager to learn']],
  ['receiving', ['receiving', 'delivery', 'deliveries', 'vendor', 'purchase order']],
  ['multi-site operations', ['multi site', 'multiple locations', 'two locations']],
  ['quality control', ['quality', 'calibration', 'temperature', 'logs', 'documented yields']],
  ['certification', ['certificate', 'certified', 'certification', 'servsafe']],
  ['reliability', ['reliable', 'reliability', 'regularly worked', 'available']],
  ['operations', ['operations', 'operational', 'service operations', 'production planning']],
] as const;

const HASH_DIMENSIONS = 64;
export const CONCEPT_VECTOR_DIMENSIONS = CONCEPTS.length + HASH_DIMENSIONS;

const STOP_WORDS = new Set([
  'and', 'are', 'for', 'from', 'has', 'have', 'into', 'looking', 'need', 'our',
  'person', 'someone', 'that', 'the', 'their', 'this', 'who', 'with', 'work',
]);

export type SearchVector = readonly number[];
export type SourceBlockVector = {
  sourceBlockId: string;
  values: SearchVector;
};

export type QueryInspection =
  | { ok: true; query: string }
  | { ok: false; code: 'invalid_request' | 'unsafe_query'; message: string };

function normalizedText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9+#.]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function hasTerm(text: string, term: string): boolean {
  return ` ${text} `.includes(` ${normalizedText(term)} `);
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function finiteVector(vector: SearchVector): boolean {
  return vector.length > 0
    && vector.every(value => Number.isFinite(value))
    && vector.some(value => value !== 0);
}

function roundSimilarity(value: number): number {
  return Math.round(Math.max(-1, Math.min(1, value)) * 10_000) / 10_000;
}

export function inspectDemoSearchQuery(value: string): QueryInspection {
  if (NON_PRINTING.test(value)) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'The search contains unsupported control characters.',
    };
  }

  const query = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (query.length < 3 || query.length > 280 || Buffer.byteLength(query, 'utf8') > 560) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'Enter a job-related search between 3 and 280 characters.',
    };
  }
  if (CONTACT_OR_SECRET.test(query) || DATABASE_ID.test(query)) {
    return {
      ok: false,
      code: 'unsafe_query',
      message: 'Do not include contact details, record IDs, or credentials in this public demo.',
    };
  }
  if (
    PROTECTED_OR_MEDICAL_TRAIT.test(query)
    || CONTEXTUAL_IDENTITY_TRAIT.test(query)
    || AGE_PROXY.test(query)
    || DECISION_OR_MANIPULATION.test(query)
  ) {
    return {
      ok: false,
      code: 'unsafe_query',
      message: 'Search only job-relevant skills, experience, certifications, or schedule. TeamFlow does not rank protected or medical traits or make hiring decisions.',
    };
  }
  return { ok: true, query };
}

export function createConceptVector(value: string): number[] {
  const text = normalizedText(value);
  const vector = Array<number>(CONCEPT_VECTOR_DIMENSIONS).fill(0);

  CONCEPTS.forEach(([, terms], conceptIndex) => {
    let matches = 0;
    for (const term of terms) {
      if (hasTerm(text, term)) matches += 1;
    }
    if (matches > 0) vector[conceptIndex] = 1 + Math.min(matches - 1, 3) * 0.2;
  });

  const tokens = new Set(
    text.split(' ').filter(token => token.length >= 3 && !STOP_WORDS.has(token)),
  );
  for (const token of tokens) {
    const hash = fnv1a(token);
    const bucket = CONCEPTS.length + (hash % HASH_DIMENSIONS);
    const sign = (hash & 0x100) === 0 ? 1 : -1;
    vector[bucket] += sign * 0.18;
  }
  return vector;
}

export function cosineSimilarity(left: SearchVector, right: SearchVector): number {
  if (left.length !== right.length || !finiteVector(left) || !finiteVector(right)) {
    throw new Error('semantic_search_vector_invalid');
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function sourceBlockEmbeddingText(sourceBlock: SyntheticSourceBlock): string {
  // Rank exactly what the UI cites. Adding profile metadata here would make the
  // returned block similarity depend on evidence the citation does not contain.
  return sourceBlock.text;
}

export function createFallbackSourceVectors(): SourceBlockVector[] {
  return CANDIDATE_CORPUS.flatMap(candidate => (
    candidate.sourceBlocks.map(sourceBlock => ({
      sourceBlockId: sourceBlock.sourceBlockId,
      values: createConceptVector(sourceBlockEmbeddingText(sourceBlock)),
    }))
  ));
}

function assertSourceVectors(sourceVectors: readonly SourceBlockVector[], dimensions: number): Map<string, SearchVector> {
  const expectedBlocks = CANDIDATE_CORPUS.flatMap(candidate => candidate.sourceBlocks);
  if (sourceVectors.length !== expectedBlocks.length || dimensions < 1) {
    throw new Error('semantic_search_corpus_vector_count_invalid');
  }

  const vectorsById = new Map<string, SearchVector>();
  for (const sourceVector of sourceVectors) {
    if (
      vectorsById.has(sourceVector.sourceBlockId)
      || sourceVector.values.length !== dimensions
      || !finiteVector(sourceVector.values)
    ) {
      throw new Error('semantic_search_corpus_vector_invalid');
    }
    vectorsById.set(sourceVector.sourceBlockId, sourceVector.values);
  }
  for (const block of expectedBlocks) {
    if (!vectorsById.has(block.sourceBlockId)) {
      throw new Error('semantic_search_corpus_vector_missing');
    }
  }
  return vectorsById;
}

export function rankSyntheticCandidates(
  queryVector: SearchVector,
  sourceVectors: readonly SourceBlockVector[],
  limit = 5,
): DemoSearchResult[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5 || !finiteVector(queryVector)) {
    throw new Error('semantic_search_request_vector_invalid');
  }
  const vectorsById = assertSourceVectors(sourceVectors, queryVector.length);

  const ranked = CANDIDATE_CORPUS.map(candidate => {
    const sources = candidate.sourceBlocks
      .map(sourceBlock => ({
        sourceBlock,
        similarity: cosineSimilarity(
          queryVector,
          vectorsById.get(sourceBlock.sourceBlockId) as SearchVector,
        ),
      }))
      .sort((left, right) => (
        right.similarity - left.similarity
        || left.sourceBlock.sourceBlockId.localeCompare(right.sourceBlock.sourceBlockId)
      ));
    const citations = sources.slice(0, 2);
    const candidateSimilarity = citations.length === 1
      ? citations[0].similarity
      : (citations[0].similarity * 0.75) + (citations[1].similarity * 0.25);
    return { candidate, citations, candidateSimilarity };
  }).sort((left, right) => (
    right.candidateSimilarity - left.candidateSimilarity
    || left.candidate.candidateRef.localeCompare(right.candidate.candidateRef)
  ));

  return ranked.slice(0, limit).map(({ candidate, citations, candidateSimilarity }, index) => {
    const evidenceTopics = [...new Set(citations.flatMap(citation => citation.sourceBlock.topics))].slice(0, 8);
    return {
      synthetic_candidate_ref: candidate.candidateRef,
      display_name: candidate.displayName,
      headline: candidate.headline,
      location: candidate.location,
      years_experience: candidate.yearsExperience,
      skills: [...candidate.skills],
      evidence_topics: evidenceTopics,
      rank: index + 1,
      weighted_evidence_similarity: roundSimilarity(candidateSimilarity),
      citations: citations.map(({ sourceBlock, similarity }) => ({
        citation_id: sourceBlock.sourceBlockId.replace('SYN-RES-', 'CIT-SYN-'),
        source_block_id: sourceBlock.sourceBlockId,
        document_label: 'Synthetic resume' as const,
        location: `${sourceBlock.section} · block ${sourceBlock.blockNumber}`,
        exact_quote: sourceBlock.text,
        similarity: roundSimilarity(similarity),
      })),
    };
  });
}

export function assertLiteralSourceCitations(results: readonly DemoSearchResult[]): void {
  const candidatesById = new Map(
    CANDIDATE_CORPUS.map(candidate => [candidate.candidateRef, candidate] as const),
  );
  for (const result of results) {
    const candidate = candidatesById.get(result.synthetic_candidate_ref);
    if (!candidate) throw new Error('semantic_search_result_candidate_invalid');
    const blocksById = new Map(
      candidate.sourceBlocks.map(sourceBlock => [sourceBlock.sourceBlockId, sourceBlock] as const),
    );
    for (const citation of result.citations) {
      const sourceBlock = blocksById.get(citation.source_block_id);
      if (
        !sourceBlock
        || citation.exact_quote !== sourceBlock.text
        || citation.location !== `${sourceBlock.section} · block ${sourceBlock.blockNumber}`
        || citation.citation_id !== sourceBlock.sourceBlockId.replace('SYN-RES-', 'CIT-SYN-')
      ) {
        throw new Error('semantic_search_citation_not_literal');
      }
    }
  }
}

export function validateSyntheticCorpus(): void {
  const candidateIds = new Set<string>();
  const sourceIds = new Set<string>();
  for (const candidate of CANDIDATE_CORPUS) {
    if (candidateIds.has(candidate.candidateRef) || candidate.sourceBlocks.length < 1) {
      throw new Error('semantic_search_corpus_invalid');
    }
    candidateIds.add(candidate.candidateRef);
    for (const sourceBlock of candidate.sourceBlocks) {
      if (
        sourceIds.has(sourceBlock.sourceBlockId)
        || !sourceBlock.text.trim()
        || sourceBlock.blockNumber < 1
      ) {
        throw new Error('semantic_search_corpus_invalid');
      }
      sourceIds.add(sourceBlock.sourceBlockId);
    }
  }
}
