-- Migration: Add pgvector embedding column to candidates table
-- Run this against your Supabase project (SQL Editor or CLI)
-- Requires: CREATE EXTENSION IF NOT EXISTS "vector" (already in schema.sql)

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS embedding vector(768);

-- HNSW index for fast approximate nearest-neighbor search
-- Using cosine distance (<=>) — best for text embeddings
CREATE INDEX IF NOT EXISTS candidates_embedding_idx
  ON candidates
  USING hnsw (embedding vector_cosine_ops);

-- RPC function for semantic similarity search
-- Called by mcp_server.py's semantic_search_candidates tool
CREATE OR REPLACE FUNCTION match_candidates(
  query_embedding vector(768),
  match_merchant_id UUID,
  match_threshold FLOAT DEFAULT 0.5,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  email TEXT,
  status TEXT,
  fit_score INTEGER,
  summary TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.email,
    c.status,
    c.fit_score,
    c.summary,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM candidates c
  WHERE
    c.merchant_id = match_merchant_id
    AND c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
