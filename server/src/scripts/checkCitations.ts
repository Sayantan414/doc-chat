// Measures the RAG pipeline on a test set: retrieval, citation format, page accuracy and "I don't know".
// The questions live in a JSON file per document (see eval/), so any PDF can be tested without code changes.
// Run with: npx tsx server/src/scripts/checkCitations.ts eval/bitcoin.json

import { readFile } from "node:fs/promises";
import { pool } from "../db/pool.js";
import { llm } from "../llm/index.js";
import { buildRagMessages } from "../retrieval/prompt.js";
import { searchChunks } from "../retrieval/search.js";

// Answerable: validPages = the pages of `document` that truly contain the answer.
// Unanswerable: expectUnknown = the answer is not in the document, so "I don't know" is correct.
// `note` is only for people reading the file; the checker ignores it.
type TestCase =
  | { question: string; validPages: number[]; note?: string }
  | { question: string; expectUnknown: true; note?: string };

interface TestSet {
  document: string; // file name as saved in the documents table, e.g. "bitcoin.pdf"
  questions: TestCase[];
}

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npx tsx server/src/scripts/checkCitations.ts <test-set.json>");
  process.exit(1);
}

// JSON.parse turns the file's text into a JS object. `as TestSet` tells TypeScript its shape;
// TypeScript can't check a file at runtime, so the file must follow this shape.
const testSet = JSON.parse(await readFile(filePath, "utf8")) as TestSet;
console.log(`Test set: ${filePath} (${testSet.questions.length} questions on ${testSet.document})\n`);

let answerable = 0;
let retrievalOk = 0;
let formatOk = 0;
let pageOk = 0;
let unanswerable = 0;
let unknownOk = 0;
const runStart = performance.now();
const mark = (pass: boolean) => (pass ? "✅" : "❌");

for (const testCase of testSet.questions) {
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

  // What the search found: pages from the test set's document, and how many chunks came from other documents.
  const retrievedPages = chunks.filter((c) => c.documentName === testSet.document).map((c) => c.page);
  const otherDoc = chunks.length - retrievedPages.length;
  const seconds = ((performance.now() - start) / 1000).toFixed(0);

  if ("expectUnknown" in testCase) {
    // Pass = says "I don't know" (straight or curly apostrophe) AND cites no page.
    unanswerable++;
    const saysUnknown = /i don['’]t know/i.test(answer);
    const unknownPass = saysUnknown && pages.length === 0;
    if (unknownPass) unknownOk++;

    console.log(`${mark(unknownPass)} ${question}`);
    console.log(`   retrieved [${retrievedPages.join(", ")}]  other doc ${otherDoc}/${chunks.length}`);
    console.log(`   expected "I don't know"  cited [${pages.join(", ")}]  (${seconds}s)`);
  } else {
    // Three separate checks, because each one needs a different fix:
    //   retrieval: did the search bring at least one chunk from a valid page? (if not: fix search)
    //   format:    is every page mention written exactly as [page N]?          (if not: fix prompt)
    //   page:      is every cited page one that really contains the answer?    (if not: prompt/model)
    // Note: citations don't name the document, so the page check assumes they refer to testSet.document.
    answerable++;
    const { validPages } = testCase;
    const retrievalPass = retrievedPages.some((p) => validPages.includes(p));
    const exact = [...answer.matchAll(/\[page (\d+)\]/g)];
    const formatPass = mentions.length > 0 && exact.length === mentions.length;
    const pagePass = pages.length > 0 && pages.every((p) => validPages.includes(p));
    if (retrievalPass) retrievalOk++;
    if (formatPass) formatOk++;
    if (pagePass) pageOk++;

    console.log(`${mark(retrievalPass && formatPass && pagePass)} ${question}`);
    console.log(
      `   retrieved [${retrievedPages.join(", ")}]  other doc ${otherDoc}/${chunks.length}  retrieval ${mark(retrievalPass)}`,
    );
    console.log(
      `   cited [${pages.join(", ")}]  valid [${validPages.join(", ")}]  format ${mark(formatPass)}  page ${mark(pagePass)}  (${seconds}s)`,
    );
  }
  console.log(`   answer: ${answer.replace(/\s+/g, " ").trim()}\n`);
}

const minutes = ((performance.now() - runStart) / 60000).toFixed(1);
console.log(
  `Retrieval hit: ${retrievalOk}/${answerable}   Format: ${formatOk}/${answerable}   ` +
    `Page accuracy: ${pageOk}/${answerable}   I don't know: ${unknownOk}/${unanswerable}   (${minutes} min)`,
);

await pool.end();
