// Loads a PDF into the database: load -> chunk -> embed -> save.
// Run with: npx tsx server/src/scripts/ingest.ts pdfs/bitcoin.pdf

import { pool } from "../db/pool.js";
import { ingestPdf } from "../ingest/embed.js";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npx tsx server/src/scripts/ingest.ts <path-to-pdf>");
  process.exit(1);
}

const start = Date.now();
const { documentId, chunkCount, duplicate } = await ingestPdf(filePath);
const seconds = ((Date.now() - start) / 1000).toFixed(1);
console.log(
  duplicate
    ? `Already ingested as document ${documentId} (${chunkCount} chunks), skipped in ${seconds}s`
    : `Saved document ${documentId} with ${chunkCount} chunks in ${seconds}s`,
);

// Close the pool's open connections, otherwise Node keeps running.
await pool.end();
