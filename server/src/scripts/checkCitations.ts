// Measures citation accuracy and "I don't know": asks fixed questions through the RAG pipeline,
// checks that every [page N] is a page that really contains the answer, and that questions
// the document can't answer get "I don't know" with no citation.
// Run with: npx tsx server/src/scripts/checkCitations.ts

import { pool } from "../db/pool.js";
import { llm } from "../llm/index.js";
import { buildRagMessages } from "../retrieval/prompt.js";
import { searchChunks } from "../retrieval/search.js";

// Answerable: validPages = the pages that truly contain the answer in bitcoin.pdf.
// Unanswerable: expectUnknown = the answer is not in the document, so "I don't know" is correct.
type TestCase = { question: string; validPages: number[] } | { question: string; expectUnknown: true };

const testCases: TestCase[] = [
  { question: "What is proof-of-work?", validPages: [3] },
  { question: "How does Bitcoin prevent double-spending?", validPages: [1, 2] },
  { question: "How are blocks linked together?", validPages: [2, 3] },
  { question: "What happens if an attacker controls more CPU power?", validPages: [4] },
  { question: "What is the capital of France?", expectUnknown: true },
  // Hard on purpose: the retrieved chunks are about crypto, and the model knows the answer.
  { question: "Who invented Ethereum?", expectUnknown: true },
];

let answerable = 0;
let formatOk = 0;
let pageOk = 0;
let unanswerable = 0;
let unknownOk = 0;
const runStart = performance.now();
const mark = (pass: boolean) => (pass ? "✅" : "❌");

for (const testCase of testCases) {
  const { question } = testCase;
  const start = performance.now();
  const chunks = await searchChunks(question, 5);

  // Collect the whole answer; we don't need to watch it stream here.
  // temperature 0 (same as rag.ts) so every run gives the same answer and scores are comparable.
  let answer = "";
  for await (const token of llm.chat(buildRagMessages(question, chunks), { temperature: 0 })) {
    answer += token;
  }

  // Any page mention, in any style: "[page 6]", "[page 6 (bitcoin.pdf)]", "on page 8".
  // \s+ = one or more spaces, (\d+) captures the number, the i flag ignores upper/lower case.
  const mentions = [...answer.matchAll(/page\s+(\d+)/gi)].map((m) => Number(m[1]));
  const pages = [...new Set(mentions)];
  const seconds = ((performance.now() - start) / 1000).toFixed(0);

  if ("expectUnknown" in testCase) {
    // Pass = says "I don't know" (straight or curly apostrophe) AND cites no page.
    unanswerable++;
    const saysUnknown = /i don['’]t know/i.test(answer);
    const unknownPass = saysUnknown && pages.length === 0;
    if (unknownPass) unknownOk++;

    console.log(`${mark(unknownPass)} ${question}`);
    console.log(`   expected "I don't know"  pages [${pages.join(", ")}]  (${seconds}s)`);
  } else {
    // Two separate checks, because they need different fixes:
    //   format: is every page mention written exactly as [page N]?
    //   page:   is every mentioned page one that really contains the answer?
    answerable++;
    const exact = [...answer.matchAll(/\[page (\d+)\]/g)];
    const formatPass = mentions.length > 0 && exact.length === mentions.length;
    const pagePass = pages.length > 0 && pages.every((p) => testCase.validPages.includes(p));
    if (formatPass) formatOk++;
    if (pagePass) pageOk++;

    console.log(`${mark(formatPass && pagePass)} ${question}`);
    console.log(
      `   pages [${pages.join(", ")}]  valid [${testCase.validPages.join(", ")}]  format ${mark(formatPass)}  page ${mark(pagePass)}  (${seconds}s)`,
    );
  }
  console.log(`   answer: ${answer.replace(/\s+/g, " ").trim()}\n`);
}

const minutes = ((performance.now() - runStart) / 60000).toFixed(1);
console.log(
  `Format: ${formatOk}/${answerable}   Page accuracy: ${pageOk}/${answerable}   I don't know: ${unknownOk}/${unanswerable}   (${minutes} min)`,
);

await pool.end();
