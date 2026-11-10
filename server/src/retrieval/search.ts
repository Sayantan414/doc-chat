// Query step 1 (the "R" in RAG): find the chunks closest in meaning to the question.

import pgvector from "pgvector/pg";
import { pool } from "../db/pool.js";
import { llm } from "../llm/index.js";

// Questions get "search_query: ", chunks got "search_document: " (see ingest/embed.ts).
const QUERY_PREFIX = "search_query: ";

export interface SearchResult {
  documentName: string;
  page: number;
  content: string;
  distance: number; // cosine distance: 0 = same meaning, bigger = less related
}

// Search = two separate steps (kept apart so each one can be timed on its own):
//   1. embedQuery:     question -> vector (runs the embedding model in Ollama)
//   2. searchByVector: vector -> nearest chunks (runs the SQL query in Postgres)
export async function searchChunks(question: string, topK = 5): Promise<SearchResult[]> {
  return searchByVector(await embedQuery(question), topK);
}

export async function embedQuery(question: string): Promise<number[]> {
  // Must use the SAME embedding model as the chunks, or the vectors can't be compared.
  return llm.embed(QUERY_PREFIX + question);
}

export async function searchByVector(queryVector: number[], topK = 5): Promise<SearchResult[]> {
  // <=> = cosine distance. ORDER BY it + LIMIT = "the K nearest chunks".
  // AS "documentName" (in quotes) keeps the camelCase name in the JS result.
  const { rows } = await pool.query<SearchResult>(
    `SELECT d.name AS "documentName",
            c.page,
            c.content,
            c.embedding <=> $1 AS distance
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
      ORDER BY c.embedding <=> $1
      LIMIT $2`,
    [pgvector.toSql(queryVector), topK],
  );
  return rows;
}

export interface KeywordResult extends Omit<SearchResult, "distance"> {
  rank: number; // ts_rank: bigger = more of the question's words, more often
}

// Keyword search (full-text search on chunks.tsv): finds exact words like
// "clearInterval" or "satoshin@gmx.com" that the embedding blurs.
// The question's words are joined with OR (|), not AND: websearch_to_tsquery
// would AND them, and "How is the ADMIN role checked?" then matched 0 chunks
// (no chunk has admin AND role AND check). ts_rank puts chunks with more of
// the words first. quote_literal keeps words with ' or & from breaking the
// query. A question of only stop words ("the is a") gives no words: 0 results.
export async function searchByKeyword(question: string, topK = 5): Promise<KeywordResult[]> {
  const { rows } = await pool.query<KeywordResult>(
    `WITH q AS (
       SELECT (SELECT string_agg(quote_literal(word), ' | ')
                 FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS word
              )::tsquery AS query
     )
     SELECT d.name AS "documentName",
            c.page,
            c.content,
            ts_rank(c.tsv, q.query) AS rank
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       CROSS JOIN q
      WHERE c.tsv @@ q.query
      ORDER BY rank DESC, c.id -- c.id: same order every run when ranks tie
      LIMIT $2`,
    [question, topK],
  );
  return rows;
}
