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

// The search the chat uses. Two separate steps (kept apart so each one can be timed):
//   1. embedQuery:   question -> vector (runs the embedding model in Ollama)
//   2. searchHybrid: vector + keyword search, merged with RRF (one SQL query)
// If you change how this searches, bump RETRIEVAL_VERSION so cached answers
// built from the old search aren't served.
export const RETRIEVAL_VERSION = "hybrid-rrf-v1";
// documentIds: search only these documents; undefined or [] = all documents.
export async function searchChunks(question: string, topK = 5, documentIds?: number[]): Promise<SearchResult[]> {
  return searchHybrid(question, await embedQuery(question), topK, documentIds);
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
// The question as an OR tsquery ('admin' | 'check' | 'role'); $1 = the question.
const OR_QUERY_SQL = `
  SELECT (SELECT string_agg(quote_literal(word), ' | ')
            FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS word
         )::tsquery AS query`;

export async function searchByKeyword(question: string, topK = 5): Promise<KeywordResult[]> {
  const { rows } = await pool.query<KeywordResult>(
    `WITH q AS (${OR_QUERY_SQL})
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

// Each search brings this many candidates to the merge. More than topK, so a
// chunk ranked 12th by one search and 3rd by the other can still win.
const CANDIDATES = 20;
// RRF constant from the original paper (Cormack et al., 2009). A big k makes
// rank 1 only a little better than rank 5, so agreement between the two
// searches counts for more than either one's top pick.
const RRF_K = 60;

// Hybrid search: vector + keyword, merged with Reciprocal Rank Fusion.
//   score = 1/(k + vector rank) + 1/(k + keyword rank), 0 for a list it isn't in
// Ranks, not raw scores: cosine distance and ts_rank have different scales
// and can't be added. One SQL query, so it's one round trip to Postgres.
// distance is computed for every result (also keyword-only ones), so the
// result has the same shape as before and the UI chips still work.
//
// documentIds ($6, NULL = all) filters INSIDE both candidate lists, before
// their LIMIT: filtering after the merge could leave fewer than topK chunks.
// With the HNSW index the filter runs after the index walk, so a small
// document could get only a few candidates; hnsw.iterative_scan (db/pool.ts)
// keeps walking until enough rows pass the filter.
export async function searchHybrid(
  question: string,
  queryVector: number[],
  topK = 5,
  documentIds?: number[],
): Promise<SearchResult[]> {
  const { rows } = await pool.query<SearchResult>(
    `WITH q AS (${OR_QUERY_SQL}),
     -- MATERIALIZED + re-sort below: iterative_scan = relaxed_order may return
     -- rows slightly out of distance order, so the ranks must come from a real
     -- sort, not from the index order (pattern from the pgvector docs).
     vec_candidates AS MATERIALIZED (
       SELECT c.id, c.embedding <=> $2 AS distance
         FROM chunks c
        WHERE $6::int[] IS NULL OR c.document_id = ANY($6)
        ORDER BY c.embedding <=> $2
        LIMIT $4
     ),
     vec AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY distance, id) AS r FROM vec_candidates
     ),
     kw AS (
       SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank(c.tsv, q.query) DESC, c.id) AS r
         FROM chunks c CROSS JOIN q
        WHERE c.tsv @@ q.query
          AND ($6::int[] IS NULL OR c.document_id = ANY($6))
        ORDER BY ts_rank(c.tsv, q.query) DESC, c.id
        LIMIT $4
     ),
     fused AS (
       SELECT COALESCE(vec.id, kw.id) AS id,
              COALESCE(1.0 / ($5 + vec.r), 0) + COALESCE(1.0 / ($5 + kw.r), 0) AS score
         FROM vec FULL OUTER JOIN kw ON kw.id = vec.id
     )
     SELECT d.name AS "documentName",
            c.page,
            c.content,
            c.embedding <=> $2 AS distance
       FROM fused f
       JOIN chunks c ON c.id = f.id
       JOIN documents d ON d.id = c.document_id
      ORDER BY f.score DESC, distance -- distance breaks ties between equal scores
      LIMIT $3`,
    [question, pgvector.toSql(queryVector), topK, CANDIDATES, RRF_K, documentIds?.length ? documentIds : null],
  );
  return rows;
}
