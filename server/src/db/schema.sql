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
