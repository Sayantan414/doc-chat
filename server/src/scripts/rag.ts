// The complete RAG query path: search -> build prompt -> stream answer -> show sources,
// with a timing for every stage so you can see where the time goes.
// Run with: npx tsx server/src/scripts/rag.ts "your question"

import { pool } from "../db/pool.js";
import { llm } from "../llm/index.js";
import { buildRagMessages } from "../retrieval/prompt.js";
import { embedQuery, searchByVector } from "../retrieval/search.js";

const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error('Usage: npx tsx server/src/scripts/rag.ts "your question"');
  process.exit(1);
}

// performance.now() = a precise clock in milliseconds, good for measuring short steps.
const t0 = performance.now();

// R - Retrieve, part 1: question -> vector (embedding model in Ollama).
const queryVector = await embedQuery(question);
const t1 = performance.now();

// R - Retrieve, part 2: vector -> the 5 nearest chunks (SQL in Postgres).
const chunks = await searchByVector(queryVector, 5);
const t2 = performance.now();

// A - Augment: put those chunks into the prompt.
const messages = buildRagMessages(question, chunks);
const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
const t3 = performance.now();

// G - Generate: stream the answer. Two moments matter:
//   first token = the model has read the whole prompt and starts writing
//   last token  = the answer is finished
console.log(`You: ${question}\n`);
process.stdout.write("AI: ");
let firstTokenAt = 0;
let pieces = 0;
// temperature 0: factual, repeatable answers from the document.
for await (const token of llm.chat(messages, { temperature: 0 })) {
  if (!firstTokenAt) firstTokenAt = performance.now();
  pieces++;
  process.stdout.write(token);
}
const t4 = performance.now();

console.log("\n\nSources given to the model:");
for (const c of chunks) {
  console.log(`  ${c.documentName}, page ${c.page} (distance ${c.distance.toFixed(3)})`);
}

const ms = (n: number) => `${Math.round(n)} ms`.padStart(9);
const generating = (t4 - firstTokenAt) / 1000;
console.log("\nTimings:");
console.log(`  embed question     ${ms(t1 - t0)}`);
console.log(`  vector search (DB) ${ms(t2 - t1)}`);
console.log(`  build prompt       ${ms(t3 - t2)}   (${promptChars} chars, ~${Math.round(promptChars / 4)} tokens)`);
console.log(`  wait first token   ${ms(firstTokenAt - t3)}   (model reads the prompt)`);
console.log(`  generate answer    ${ms(t4 - firstTokenAt)}   (${pieces} pieces, ~${(pieces / generating).toFixed(1)} per second)`);
console.log(`  total              ${ms(t4 - t0)}`);

await pool.end();
