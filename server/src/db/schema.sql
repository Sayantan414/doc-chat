-- DocChat database schema. Safe to run many times (IF NOT EXISTS).

-- pgvector adds the `vector` column type and the <=> distance operators.
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per uploaded PDF.
CREATE TABLE IF NOT EXISTS documents (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- SHA-256 of the file's bytes (64 hex characters), so the same PDF is ingested
-- only once, whatever it is called. UNIQUE makes Postgres refuse a second row
-- with the same hash, even when two uploads of one file arrive together.
-- Added after the table existed, hence ALTER ... IF NOT EXISTS. Old rows get
-- NULL; UNIQUE allows any number of NULLs.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash TEXT UNIQUE;

-- One row per chunk of text. Each chunk keeps its page number for citations.
CREATE TABLE IF NOT EXISTS chunks (
  id          SERIAL PRIMARY KEY,
  -- ON DELETE CASCADE: deleting a document also deletes its chunks.
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page        INTEGER NOT NULL,
  content     TEXT NOT NULL,
  -- 768 = the number of dimensions nomic-embed-text produces.
  embedding   VECTOR(768) NOT NULL
);

-- Keyword search (full-text search). tsv = the chunk's words, lowercased,
-- stemmed ("checked" -> "check") and without stop words ("the", "is").
-- GENERATED ... STORED: Postgres fills it on every INSERT (and for old rows
-- when the column is added), so the ingest code doesn't change.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

-- GIN = an inverted index: word -> the chunks that contain it, so a keyword
-- search doesn't have to read every chunk.
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING GIN (tsv);

-- Vector search index. HNSW = a graph of nearest neighbours; a search walks it
-- instead of comparing the question with every chunk. Approximate: it can miss
-- a true neighbour now and then (hnsw.ef_search trades speed for recall).
-- HNSW, not IVFFlat: it needs no training data, so it stays good as uploads
-- add chunks. vector_cosine_ops must match the <=> (cosine) operator we query
-- with, or Postgres silently skips the index.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx ON chunks
  USING hnsw (embedding vector_cosine_ops);

-- Chat history (Step 5). One conversation has many messages.
CREATE TABLE IF NOT EXISTS conversations (
  id              SERIAL PRIMARY KEY,
  title           TEXT NOT NULL,              -- the first question, cut to 80 characters
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(), -- bumped on every new message (trigger below)
  -- Set while an answer is being written, NULL otherwise. A second question
  -- to the same conversation gets a 409 meanwhile. A server crash would leave
  -- it set, so a value older than 5 minutes counts as free again (chat.ts).
  answering_since TIMESTAMPTZ
);

-- The conversation list shows the most recently used first.
CREATE INDEX IF NOT EXISTS conversations_updated_at_idx ON conversations (updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- CHECK: Postgres itself refuses a wrong role or status, whatever bug the code has.
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  -- user messages: 'done'. assistant: 'done', 'stopped' (client left; content
  -- = the part written so far) or 'error' (see error).
  status          TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'stopped', 'error')),
  error           TEXT,
  -- A COPY of the chunks the model was given (name, page, text), not chunk ids:
  -- deleting a PDF deletes its chunks, and old answers must keep their citations.
  sources         JSONB,
  -- What was searched: the documentIds of the question (NULL = all documents).
  document_ids    INTEGER[],
  cached          BOOLEAN NOT NULL DEFAULT false, -- answer came from the answer cache
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "All messages of a conversation, in order" is the main query.
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, id);

-- A trigger, not code in chat.ts: every new message bumps updated_at, whichever
-- code path inserts it.
CREATE OR REPLACE FUNCTION touch_conversation() RETURNS trigger AS $$
BEGIN
  UPDATE conversations SET updated_at = now() WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER messages_touch_conversation
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION touch_conversation();
