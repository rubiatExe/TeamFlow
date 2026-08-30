import { createHash } from 'node:crypto';

import { z } from 'zod';

export const DOCUMENT_EXTRACTION_SCHEMA_VERSION = '1.0' as const;
export const DOCUMENT_EMBEDDING_DIMENSIONS = 768;

const MAX_DOCUMENT_TEXT_CODE_POINTS = 100_000;
const MAX_SOURCE_BLOCK_TEXT_CODE_POINTS = 4_000;
const MAX_SOURCE_BLOCKS = 512;
const MAX_SOURCE_BLOCK_ORDINAL = 9_999;
const MAX_PAGE_NUMBER = 9_999;
const MAX_PAGE_COUNT = 50;

const sha256Pattern = /^[0-9a-f]{64}$/;
const documentIdPattern = /^doc-[0-9a-f]{64}$/;
const sourceBlockIdPattern = /^src-([0-9a-f]{12})-p([0-9]{4})-b([0-9]{4})-([0-9a-f]{12})$/;
const modelIdPattern = /^[A-Za-z0-9._/:-]+$/;
const sharedBlankTextPattern = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]*$/u;

function boundedText(maxCodePoints: number) {
  return z.string().superRefine((value, context) => {
    if (/[\uD800-\uDFFF]/u.test(value)) {
      context.addIssue({
        code: 'custom',
        message: 'text must not contain an unpaired UTF-16 surrogate',
      });
      return;
    }
    if (value.length > maxCodePoints * 2) {
      context.addIssue({
        code: 'custom',
        message: `text must contain at most ${maxCodePoints} Unicode code points`,
      });
      return;
    }
    if (Array.from(value).length > maxCodePoints) {
      context.addIssue({
        code: 'custom',
        message: `text must contain at most ${maxCodePoints} Unicode code points`,
      });
    }
  });
}

function nonBlankText(maxCodePoints: number) {
  return boundedText(maxCodePoints).superRefine((value, context) => {
    if (sharedBlankTextPattern.test(value)) {
      context.addIssue({ code: 'custom', message: 'text must not be blank' });
    }
  });
}

function isBlank(value: string): boolean {
  return sharedBlankTextPattern.test(value);
}

function hasDuplicates<T>(values: readonly T[]): boolean {
  return new Set(values).size !== values.length;
}

export const ExtractionStatusSchema = z.enum([
  'complete',
  'degraded',
  'failed',
  'mock',
]);

export const ExtractionMethodSchema = z.enum([
  'pdf_text',
  'gemini_vision',
  'none',
  'mock',
]);

export const ExtractionWarningSchema = z.enum([
  'ocr_required',
  'embedding_failed',
  'embedding_input_truncated',
  'malformed_document',
  'encrypted_document',
  'page_limit_exceeded',
  'pdf_text_timeout',
  'pdf_text_overloaded',
  'ocr_provider_failed',
  'ocr_provider_timeout',
  'ocr_response_incomplete',
  'provider_unavailable',
  'empty_extraction',
  'malformed_extraction',
  'mock_mode_enabled',
]);

export const QualityAssessmentSchema = z.enum(['usable', 'unusable']);

export const ExtractionQualityReasonSchema = z.enum([
  'empty_text',
  'insufficient_text',
  'excessive_control_characters',
  'text_too_large',
  'no_source_blocks',
  'malformed_document',
  'mock_result',
]);

export const SourceBlockSchema = z.object({
  source_block_id: z.string().regex(sourceBlockIdPattern),
  page_number: z.number().int().min(1).max(MAX_PAGE_NUMBER).nullable(),
  ordinal: z.number().int().min(1).max(MAX_SOURCE_BLOCK_ORDINAL),
  text: nonBlankText(MAX_SOURCE_BLOCK_TEXT_CODE_POINTS),
}).strict().superRefine((block, context) => {
  const match = sourceBlockIdPattern.exec(block.source_block_id);
  if (!match) return;
  const expectedPage = (block.page_number ?? 0).toString().padStart(4, '0');
  const expectedOrdinal = block.ordinal.toString().padStart(4, '0');
  if (match[2] !== expectedPage || match[3] !== expectedOrdinal) {
    context.addIssue({
      code: 'custom',
      path: ['source_block_id'],
      message: 'source block ID page and ordinal must match its fields',
    });
  }
  const expectedDigest = createHash('sha256')
    .update(`${block.page_number ?? 0}|${block.ordinal}|${block.text}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
  if (match[4] !== expectedDigest) {
    context.addIssue({
      code: 'custom',
      path: ['source_block_id'],
      message: 'source block ID digest must match its canonical text',
    });
  }
});

export const ExtractionQualitySchema = z.object({
  assessment: QualityAssessmentSchema,
  character_count: z.number().int().min(0).max(MAX_DOCUMENT_TEXT_CODE_POINTS),
  block_count: z.number().int().min(0).max(MAX_SOURCE_BLOCKS),
  page_count: z.number().int().min(0).max(MAX_PAGE_COUNT),
  reason_codes: z.array(ExtractionQualityReasonSchema)
    .max(ExtractionQualityReasonSchema.options.length),
}).strict().superRefine((quality, context) => {
  if (hasDuplicates(quality.reason_codes)) {
    context.addIssue({
      code: 'custom',
      path: ['reason_codes'],
      message: 'quality reason_codes must be unique',
    });
  }
  if (quality.assessment === 'usable' && quality.reason_codes.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['reason_codes'],
      message: 'usable quality must not include failure reason codes',
    });
  }
  if (quality.assessment === 'unusable' && quality.reason_codes.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['reason_codes'],
      message: 'unusable quality requires at least one reason code',
    });
  }
});

const nullableModelId = nonBlankText(200).regex(modelIdPattern).nullable();
const EmbeddingSchema = z.array(z.number().finite())
  .length(DOCUMENT_EMBEDDING_DIMENSIONS)
  .superRefine((embedding, context) => {
    const float32Values = embedding.map(value => Math.fround(value));
    if (float32Values.some(value => !Number.isFinite(value))) {
      context.addIssue({
        code: 'custom',
        message: 'embedding values must be representable as finite float32 values',
      });
    }
    if (!float32Values.some(value => value !== 0)) {
      context.addIssue({
        code: 'custom',
        message: 'embedding must not collapse to a zero vector',
      });
    }
  });

export const DocumentExtractionResultSchema = z.object({
  schema_version: z.literal(DOCUMENT_EXTRACTION_SCHEMA_VERSION),
  document_id: z.string().regex(documentIdPattern),
  status: ExtractionStatusSchema,
  markdown: boundedText(MAX_DOCUMENT_TEXT_CODE_POINTS),
  text: boundedText(MAX_DOCUMENT_TEXT_CODE_POINTS),
  source_blocks: z.array(SourceBlockSchema).max(MAX_SOURCE_BLOCKS),
  embedding: EmbeddingSchema.nullable(),
  extraction_method: ExtractionMethodSchema,
  model_id: nullableModelId,
  embedding_model_id: nullableModelId,
  content_sha256: z.string().regex(sha256Pattern),
  mock: z.boolean(),
  warnings: z.array(ExtractionWarningSchema)
    .max(ExtractionWarningSchema.options.length),
  quality: ExtractionQualitySchema,
}).strict().superRefine((result, context) => {
  if (result.document_id !== `doc-${result.content_sha256}`) {
    context.addIssue({
      code: 'custom',
      path: ['document_id'],
      message: 'document_id must be derived from content_sha256',
    });
  }

  if (hasDuplicates(result.warnings)) {
    context.addIssue({
      code: 'custom',
      path: ['warnings'],
      message: 'warnings must be unique',
    });
  }

  if (result.quality.character_count !== Array.from(result.text).length) {
    context.addIssue({
      code: 'custom',
      path: ['quality', 'character_count'],
      message: 'character_count must equal the text Unicode code-point count',
    });
  }
  if (result.quality.block_count !== result.source_blocks.length) {
    context.addIssue({
      code: 'custom',
      path: ['quality', 'block_count'],
      message: 'block_count must equal source_blocks length',
    });
  }
  if (result.markdown !== result.text) {
    context.addIssue({
      code: 'custom',
      path: ['markdown'],
      message: 'markdown and canonical text must match in schema v1',
    });
  }

  const blockIds = result.source_blocks.map(block => block.source_block_id);
  if (hasDuplicates(blockIds)) {
    context.addIssue({
      code: 'custom',
      path: ['source_blocks'],
      message: 'source_block_id values must be unique',
    });
  }

  result.source_blocks.forEach((block, index) => {
    const expectedOrdinal = index + 1;
    if (block.ordinal !== expectedOrdinal) {
      context.addIssue({
        code: 'custom',
        path: ['source_blocks', index, 'ordinal'],
        message: 'source block ordinals must be globally ordered from 1',
      });
    }

    const match = sourceBlockIdPattern.exec(block.source_block_id);
    if (match) {
      const expectedPage = block.page_number === null
        ? '0000'
        : block.page_number.toString().padStart(4, '0');
      const expectedBlockOrdinal = block.ordinal.toString().padStart(4, '0');
      if (match[1] !== result.content_sha256.slice(0, 12)) {
        context.addIssue({
          code: 'custom',
          path: ['source_blocks', index, 'source_block_id'],
          message: 'source block document hash prefix must match content_sha256',
        });
      }
      if (match[2] !== expectedPage || match[3] !== expectedBlockOrdinal) {
        context.addIssue({
          code: 'custom',
          path: ['source_blocks', index, 'source_block_id'],
          message: 'source block ID page and ordinal must match its fields',
        });
      }
      const expectedDigest = createHash('sha256')
        .update(`${block.page_number ?? 0}|${block.ordinal}|${block.text}`, 'utf8')
        .digest('hex')
        .slice(0, 12);
      if (match[4] !== expectedDigest) {
        context.addIssue({
          code: 'custom',
          path: ['source_blocks', index, 'source_block_id'],
          message: 'source block ID digest must match its canonical text',
        });
      }
    }
    if (block.page_number !== null && block.page_number > result.quality.page_count) {
      context.addIssue({
        code: 'custom',
        path: ['source_blocks', index, 'page_number'],
        message: 'source block page cannot exceed document page count',
      });
    }
  });

  if (result.source_blocks.map(block => block.text).join('\n\n') !== result.text) {
    context.addIssue({
      code: 'custom',
      path: ['source_blocks'],
      message: 'source blocks must exactly reconstruct canonical text',
    });
  }

  if ((result.embedding === null) !== (result.embedding_model_id === null)) {
    context.addIssue({
      code: 'custom',
      path: ['embedding_model_id'],
      message: 'embedding and embedding_model_id must be present together',
    });
  }

  const extractionSucceeded = result.status === 'complete'
    || result.status === 'degraded';
  if (extractionSucceeded) {
    const failureWarnings = new Set([
      'malformed_document',
      'encrypted_document',
      'page_limit_exceeded',
      'pdf_text_timeout',
      'pdf_text_overloaded',
      'ocr_provider_failed',
      'ocr_provider_timeout',
      'ocr_response_incomplete',
      'provider_unavailable',
      'empty_extraction',
      'malformed_extraction',
      'mock_mode_enabled',
    ]);
    if (result.warnings.some(warning => failureWarnings.has(warning))) {
      context.addIssue({
        code: 'custom',
        path: ['warnings'],
        message: 'complete or degraded extraction cannot include failure warnings',
      });
    }
    if (result.mock) {
      context.addIssue({
        code: 'custom',
        path: ['mock'],
        message: 'complete or degraded extraction must not be marked mock',
      });
    }
    if (result.extraction_method !== 'pdf_text'
      && result.extraction_method !== 'gemini_vision') {
      context.addIssue({
        code: 'custom',
        path: ['extraction_method'],
        message: 'complete or degraded extraction requires an active method',
      });
    }
    if (result.model_id === null) {
      context.addIssue({
        code: 'custom',
        path: ['model_id'],
        message: 'complete or degraded extraction requires a model ID',
      });
    }
    if (isBlank(result.markdown) || isBlank(result.text)) {
      context.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'complete or degraded extraction requires nonblank content',
      });
    }
    if (result.source_blocks.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['source_blocks'],
        message: 'complete or degraded extraction requires source blocks',
      });
    }
    if (result.quality.assessment !== 'usable') {
      context.addIssue({
        code: 'custom',
        path: ['quality', 'assessment'],
        message: 'complete or degraded extraction must be usable',
      });
    }
    if (result.quality.page_count < 1) {
      context.addIssue({
        code: 'custom',
        path: ['quality', 'page_count'],
        message: 'complete or degraded extraction requires at least one page',
      });
    }
  }

  if (result.status === 'complete') {
    if (result.embedding === null) {
      context.addIssue({
        code: 'custom',
        path: ['embedding'],
        message: 'complete extraction requires a valid embedding',
      });
    }
    if (result.warnings.includes('embedding_failed')) {
      context.addIssue({
        code: 'custom',
        path: ['warnings'],
        message: 'complete extraction cannot record embedding failure',
      });
    }
  }

  if (result.status === 'degraded') {
    if (result.embedding !== null || result.embedding_model_id !== null) {
      context.addIssue({
        code: 'custom',
        path: ['embedding'],
        message: 'degraded extraction must not include an invalid embedding',
      });
    }
    if (!result.warnings.includes('embedding_failed')) {
      context.addIssue({
        code: 'custom',
        path: ['warnings'],
        message: 'degraded extraction must identify embedding failure',
      });
    }
  }

  if (result.status === 'failed' || result.status === 'mock') {
    if (
      result.markdown !== ''
      || result.text !== ''
      || result.source_blocks.length > 0
      || result.embedding !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'failed or mock extraction must not contain document content',
      });
    }
    if (result.embedding_model_id !== null || result.model_id !== null) {
      context.addIssue({
        code: 'custom',
        path: ['model_id'],
        message: 'failed or mock extraction must not identify successful models',
      });
    }
    if (
      result.quality.assessment !== 'unusable'
      || result.quality.character_count !== 0
      || result.quality.block_count !== 0
      || result.quality.page_count !== 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['quality'],
        message: 'failed or mock extraction must have empty unusable quality',
      });
    }
  }

  if (result.status === 'failed') {
    if (result.mock || result.extraction_method !== 'none') {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'failed extraction must use method none and mock=false',
      });
    }
    if (result.warnings.length === 0
      || result.warnings.includes('mock_mode_enabled')) {
      context.addIssue({
        code: 'custom',
        path: ['warnings'],
        message: 'failed extraction requires a non-mock failure warning',
      });
    }
  }

  if (result.status === 'mock') {
    if (!result.mock || result.extraction_method !== 'mock') {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'mock extraction must use method mock and mock=true',
      });
    }
    if (!result.warnings.includes('mock_mode_enabled')) {
      context.addIssue({
        code: 'custom',
        path: ['warnings'],
        message: 'mock extraction requires the mock-mode warning',
      });
    }
  }
});

export type DocumentExtractionResult = z.infer<
  typeof DocumentExtractionResultSchema
>;

export const DocumentScoreabilityReasonSchema = z.enum([
  'invalid_contract',
  'status_not_scoreable',
  'mock_result',
  'quality_unusable',
  'blank_markdown',
  'blank_text',
  'no_source_blocks',
]);

export type DocumentScoreabilityReason = z.infer<
  typeof DocumentScoreabilityReasonSchema
>;

export type DocumentScoreability = Readonly<{
  scoreable: boolean;
  reason_codes: DocumentScoreabilityReason[];
}>;

function deriveParsedScoreability(
  result: DocumentExtractionResult,
): DocumentScoreability {
  const reasonCodes: DocumentScoreabilityReason[] = [];
  if (result.status !== 'complete' && result.status !== 'degraded') {
    reasonCodes.push('status_not_scoreable');
  }
  if (result.mock) {
    reasonCodes.push('mock_result');
  }
  if (result.quality.assessment !== 'usable') {
    reasonCodes.push('quality_unusable');
  }
  if (isBlank(result.markdown)) {
    reasonCodes.push('blank_markdown');
  }
  if (isBlank(result.text)) {
    reasonCodes.push('blank_text');
  }
  if (result.source_blocks.length === 0) {
    reasonCodes.push('no_source_blocks');
  }
  return {
    scoreable: reasonCodes.length === 0,
    reason_codes: reasonCodes,
  };
}

/** Derives scoreability in trusted code; no processor-provided boolean is used. */
export function deriveDocumentScoreability(value: unknown): DocumentScoreability {
  const parsed = DocumentExtractionResultSchema.safeParse(value);
  if (!parsed.success) {
    return { scoreable: false, reason_codes: ['invalid_contract'] };
  }
  return deriveParsedScoreability(parsed.data);
}

/** Returns a validated result or fails closed before any scoring operation. */
export function assertDocumentScoreable(value: unknown): DocumentExtractionResult {
  const parsed = DocumentExtractionResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Document extraction contract is invalid');
  }
  const scoreability = deriveParsedScoreability(parsed.data);
  if (!scoreability.scoreable) {
    throw new Error(
      `Document extraction is not scoreable: ${scoreability.reason_codes.join(', ')}`,
    );
  }
  return parsed.data;
}
