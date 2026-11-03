// Shows how a PDF is cut into chunks, and the overlap between two neighbours.
// Run with: npx tsx server/src/scripts/chunk.ts pdfs/bitcoin.pdf

import { chunkPages } from "../ingest/chunk.js";
import { loadPdf } from "../ingest/loadPdf.js";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npx tsx server/src/scripts/chunk.ts <path-to-pdf>");
  process.exit(1);
}

const pages = await loadPdf(filePath);
const chunks = chunkPages(pages);

const lengths = chunks.map((c) => c.content.length);
console.log(`${pages.length} pages -> ${chunks.length} chunks`);
console.log(`chunk length: min ${Math.min(...lengths)}, max ${Math.max(...lengths)}\n`);

for (const p of pages) {
  const count = chunks.filter((c) => c.page === p.page).length;
  console.log(`page ${p.page}: ${count} chunks`);
}

// Show the first two chunks of page 1 and the text they share.
const [a, b] = chunks.filter((c) => c.page === 1);
console.log(`\n--- page 1, chunk 0 (${a.content.length} chars):\n${a.content}`);
console.log(`\n--- page 1, chunk 1 (${b.content.length} chars):\n${b.content}`);

// The overlap = the longest start of chunk 1 that is also the end of chunk 0.
let shared = "";
for (let n = Math.min(a.content.length, b.content.length); n > 0; n--) {
  if (a.content.endsWith(b.content.slice(0, n))) {
    shared = b.content.slice(0, n);
    break;
  }
}
console.log(`\n--- overlap (${shared.length} chars):\n"${shared}"`);
