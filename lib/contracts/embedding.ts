import { z } from 'zod';

export const EMBEDDING_DIMENSIONS = 3072;

// pgvector halfvec stores IEEE 754 binary16 components. At the minimum
// subnormal midpoint (2^-25), ties-to-even rounding produces zero.
export const EmbeddingSchema = z.array(z.number().finite().min(-65504).max(65504))
  .length(EMBEDDING_DIMENSIONS)
  .refine(embedding => embedding.some(value => Math.abs(value) > 2 ** -25), {
    message: 'embedding must not collapse to a zero halfvec vector',
  });
