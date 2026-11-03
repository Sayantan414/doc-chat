-- DocChat database schema. Safe to run many times (IF NOT EXISTS).

-- pgvector adds the `vector` column type and the <=> distance operators.
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per uploaded PDF.
CREATE TABLE IF NOT EXISTS documents (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
