// Measures follow-up questions (eval/followups.json): does the search find the
// right chunk for "How do I use it...?" when "it" is in the history?
//   raw:     search the follow-up as typed (what Step 5 Task 7 did)
//   rewrite: search the standalone query from rewriteQuery() (Task 8)
// Retrieval only, all documents searched. Run with:
//   npx tsx server/src/scripts/checkFollowups.ts [--rewrite]

import { readFile } from "node:fs/promises";
import { pool } from "../db/pool.js";
import { searchChunks } from "../retrieval/search.js";

interface Case {
  name: string;
  document: string;
  history: { q: string; a: string }[];
  followUp: string;
  validPages: number[];
  mustContain?: string[];
  mustNotContain?: string[];
}

const useRewrite = process.argv.includes("--rewrite");
const { cases } = JSON.parse(await readFile("eval/followups.json", "utf8")) as { cases: Case[] };
const rewriter = useRewrite ? await import("../retrieval/rewrite.js") : null;

let hits = 0;
let rrSum = 0;
let queryOk = 0;
const mark = (ok: boolean) => (ok ? "✅" : "❌");
console.log(`${cases.length} follow-ups, search = ${useRewrite ? "rewritten query" : "raw follow-up"}\n`);

for (const c of cases) {
  let query = c.followUp;
  let extra = "";
  if (rewriter) {
    const history = c.history.map((t) => ({ question: t.q, answer: t.a }));
    const r = await rewriter.rewriteQuery(c.followUp, history);
    query = r.query;
    const lower = query.toLowerCase();
    const okContain = (c.mustContain ?? []).every((w) => lower.includes(w.toLowerCase()));
    const okNot = (c.mustNotContain ?? []).every((w) => !lower.includes(w.toLowerCase()));
    if (okContain && okNot) queryOk++;
    extra = `\n   query ${mark(okContain && okNot)} "${query}"  (${r.ms} ms${r.fallback ? `, FALLBACK: ${r.fallback}` : ""})`;
  }
  const chunks = await searchChunks(query, 5);
  const pages = chunks.map((ch) => (ch.documentName === c.document ? ch.page : null));
  const rank = pages.findIndex((p) => p !== null && c.validPages.includes(p)) + 1;
  if (rank) {
    hits++;
    rrSum += 1 / rank;
  }
  console.log(`${mark(rank > 0)} ${c.name}: "${c.followUp}"${extra}`);
  console.log(`   retrieved [${pages.map((p) => p ?? "other").join(", ")}]  valid [${c.validPages.join(", ")}]  rank ${rank || "-"}`);
}

console.log(
  `\nhit@5: ${hits}/${cases.length}   MRR: ${(rrSum / cases.length).toFixed(2)}` +
    (useRewrite ? `   query checks: ${queryOk}/${cases.length}` : ""),
);
await pool.end();
