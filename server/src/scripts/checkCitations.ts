// Measures the RAG pipeline on a test set: retrieval, citation format, page accuracy and "I don't know".
// The questions live in a JSON file per document (see eval/), so any PDF can be tested without code changes.
// Run with: npx tsx server/src/scripts/checkCitations.ts eval/bitcoin.json
// Add --retrieval-only to skip the model: only the search is checked, so a run
// takes seconds and uses no Groq quota (handy when changing the search itself).
// Add --filter to search only the test set's own document (like picking it in the UI).

import { readFile } from "node:fs/promises";
import { pool } from "../db/pool.js";
import { llm } from "../llm/index.js";
import { buildRagMessages } from "../retrieval/prompt.js";
import { embedQuery, searchByKeyword, searchByVector, searchChunks, searchHybrid } from "../retrieval/search.js";

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

const args = process.argv.slice(2);
const retrievalOnly = args.includes("--retrieval-only");
// --search=vector|keyword|hybrid compares one search method on its own
// (retrieval-only). Without it, the same search as the chat (searchChunks).
const searchArg = args.find((a) => a.startsWith("--search="))?.slice("--search=".length);
const searchFns: Record<string, (q: string) => Promise<{ documentName: string; page: number }[]>> = {
  vector: async (q) => searchByVector(await embedQuery(q), 5),
  keyword: (q) => searchByKeyword(q, 5),
  hybrid: async (q) => searchHybrid(q, await embedQuery(q), 5),
};
const filter = args.includes("--filter");
const filePath = args.find((a) => !a.startsWith("--"));
if (!filePath || (searchArg && (!retrievalOnly || !searchFns[searchArg] || filter))) {
  console.error(
    "Usage: npx tsx server/src/scripts/checkCitations.ts <test-set.json> [--filter] [--retrieval-only [--search=vector|keyword|hybrid]]",
  );
  process.exit(1);
}

// JSON.parse turns the file's text into a JS object. `as TestSet` tells TypeScript its shape;
// TypeScript can't check a file at runtime, so the file must follow this shape.
const testSet = JSON.parse(await readFile(filePath, "utf8")) as TestSet;
// --filter: the test set's document id, looked up by its file name.
let documentIds: number[] | undefined;
if (filter) {
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM documents WHERE name = $1", [testSet.document]);
  if (rows.length !== 1) throw new Error(`Expected one document named ${testSet.document}, found ${rows.length}`);
  documentIds = [rows[0].id];
}
const searchName = (retrievalOnly ? `, ${searchArg ?? "chat's"} search` : "") + (filter ? `, only document ${documentIds}` : "");
console.log(`Test set: ${filePath} (${testSet.questions.length} questions on ${testSet.document}${searchName})\n`);

let answerable = 0;
let retrievalOk = 0;
let formatOk = 0;
let pageOk = 0;
let unanswerable = 0;
let unknownOk = 0;
const runStart = performance.now();
const mark = (pass: boolean) => (pass ? "✅" : "❌");
// Retrieval-only extras: where the first right chunk ranked (1 = top), and search time.
let rankSum = 0; // sum of 1/rank, for MRR (mean reciprocal rank; a miss counts 0)
let searchMsTotal = 0;

for (const testCase of testSet.questions) {
  const { question } = testCase;
  const start = performance.now();

  if (retrievalOnly) {
    const chunks = searchArg ? await searchFns[searchArg](question) : await searchChunks(question, 5, documentIds);
    const ms = Math.round(performance.now() - start);
    const pagesInOrder = chunks.map((c) => (c.documentName === testSet.document ? c.page : null));
    // "Unknown" questions have no right page; just show what came back.
    if ("expectUnknown" in testCase) {
      console.log(`·  ${question}\n   retrieved [${pagesInOrder.map((p) => p ?? "other").join(", ")}]  (${ms} ms)\n`);
      continue;
    }
    answerable++;
    searchMsTotal += ms;
    const rank = pagesInOrder.findIndex((p) => p !== null && testCase.validPages.includes(p)) + 1; // 0 = miss
    if (rank > 0) {
      retrievalOk++;
      rankSum += 1 / rank;
    }
    console.log(`${mark(rank > 0)} ${question}`);
    console.log(
      `   retrieved [${pagesInOrder.map((p) => p ?? "other").join(", ")}]  valid [${testCase.validPages.join(", ")}]  ` +
        `rank ${rank || "-"}  (${ms} ms)\n`,
    );
    continue;
  }

  const chunks = await searchChunks(question, 5, documentIds);

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
    // \s, not " ": gpt-oss (Groq) writes "[page 3]" with a narrow no-break space
    // (U+202F). It looks identical and the UI's chips accept it, so it counts as exact.
    const exact = [...answer.matchAll(/\[page\s(\d+)\]/g)];
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
if (retrievalOnly) {
  console.log(
    `Retrieval hit@5: ${retrievalOk}/${answerable}   MRR: ${(rankSum / answerable).toFixed(2)}   ` +
      `avg search: ${Math.round(searchMsTotal / answerable)} ms`,
  );
  await pool.end();
  process.exit(0);
}
console.log(
  `Retrieval hit: ${retrievalOk}/${answerable}   Format: ${formatOk}/${answerable}   ` +
    `Page accuracy: ${pageOk}/${answerable}   I don't know: ${unknownOk}/${unanswerable}   (${minutes} min)`,
);

await pool.end();
