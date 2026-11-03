// Shows which chunks the search finds for a question, WITHOUT calling the chat model.
// If the right chunk isn't in this list, no prompt can produce the right answer.
// Run with: npx tsx server/src/scripts/search.ts "your question"

import { pool } from "../db/pool.js";
import { searchChunks } from "../retrieval/search.js";

const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error('Usage: npx tsx server/src/scripts/search.ts "your question"');
  process.exit(1);
}

console.log(`Question: ${question}`);
const results = await searchChunks(question, 5);

for (const r of results) {
  console.log(`\n[distance ${r.distance.toFixed(3)}] ${r.documentName}, page ${r.page}`);
  console.log(`  ${r.content.slice(0, 150)}...`);
}

await pool.end();
