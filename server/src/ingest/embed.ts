// Ingestion step 3: turn every chunk into a vector and store it in Postgres.
// ingestPdf() ties the whole ingestion path together: load -> chunk -> embed -> save.

import path from "node:path";
import pgvector from "pgvector/pg";
import { pool } from "../db/pool.js";
import { llm } from "../llm/index.js";
import { chunkPages } from "./chunk.js";
import { hashFile } from "./hashFile.js";
import { loadPdf } from "./loadPdf.js";

// nomic-embed-text was trained with these labels: "search_document: " for text
// to be found, "search_query: " for questions (used in retrieval). It improves search quality.
export const DOCUMENT_PREFIX = "search_document: ";

export interface IngestResult {
  documentId: number;
  chunkCount: number;
  // true = this exact file was ingested before; nothing new was saved and
  // documentId is the earlier document (whatever name it was uploaded under).
  duplicate: boolean;
}

// Postgres error code for "a UNIQUE constraint refused the row".
const UNIQUE_VIOLATION = "23505";

// The earlier document with this hash, or undefined if there is none.
async function findByHash(hash: string): Promise<IngestResult | undefined> {
  const { rows } = await pool.query<{ id: number; chunks: number }>(
    `SELECT d.id, COUNT(c.id)::int AS chunks
     FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
     WHERE d.content_hash = $1
     GROUP BY d.id`,
    [hash],
  );
  if (rows.length === 0) return undefined;
  return { documentId: rows[0].id, chunkCount: rows[0].chunks, duplicate: true };
}

// `name` is what the document is called in the database. It defaults to the file
// name, but uploads are saved under random names, so the API passes the original one.
export async function ingestPdf(
  filePath: string,
  name = path.basename(filePath),
): Promise<IngestResult> {
  // Check first: hashing takes milliseconds, embedding takes most of a minute.
  const hash = await hashFile(filePath);
  const earlier = await findByHash(hash);
  if (earlier) {
    console.log(`Skipped ${name}: same file as document ${earlier.documentId}`);
    return earlier;
  }

  const pages = await loadPdf(filePath);
  const chunks = chunkPages(pages);
  console.log(`Loaded ${pages.length} pages, made ${chunks.length} chunks`);

  // Embed everything BEFORE touching the database. Embedding is the slow part;
  // if it fails halfway, nothing has been written yet.
  const embeddings: number[][] = [];
  for (const [i, chunk] of chunks.entries()) {
    embeddings.push(await llm.embed(DOCUMENT_PREFIX + chunk.content));
    // \r moves the cursor back to the line start, so the counter updates in place.
    process.stdout.write(`\rEmbedding ${i + 1}/${chunks.length}`);
  }
  process.stdout.write("\n");

  // A transaction: the document AND all its chunks are saved together, or nothing is.
  // All queries in a transaction must use the same connection, so we take one from the pool.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // RETURNING id gives us back the id Postgres generated for the new row.
    const { rows } = await client.query<{ id: number }>(
      "INSERT INTO documents (name, content_hash) VALUES ($1, $2) RETURNING id",
      [name, hash],
    );
    const documentId = rows[0].id;

    for (const [i, chunk] of chunks.entries()) {
      // $1..$4 are parameters: the values travel separately from the SQL text,
      // so PDF content can never run as SQL (no SQL injection).
      // pgvector.toSql turns a number[] into the "[0.1,0.2,...]" text Postgres expects.
      await client.query(
        "INSERT INTO chunks (document_id, page, content, embedding) VALUES ($1, $2, $3, $4)",
        [documentId, chunk.page, chunk.content, pgvector.toSql(embeddings[i])],
      );
    }

    await client.query("COMMIT");
    return { documentId, chunkCount: chunks.length, duplicate: false };
  } catch (err) {
    await client.query("ROLLBACK"); // undo everything since BEGIN
    // Two uploads of the same file at once both pass the check above, and both
    // embed. Only one INSERT can win; the loser lands here and reports the winner.
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      const winner = await findByHash(hash);
      if (winner) {
        console.log(`Skipped ${name}: the same file was saved meanwhile as document ${winner.documentId}`);
        return winner;
      }
    }
    throw err;
  } finally {
    client.release(); // give the connection back to the pool
  }
}
