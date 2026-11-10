// Answer cache: a finished answer is kept in Redis for an hour, so asking the
// same question again skips embedding, search and the model.
//
// The key must change whenever the answer could, or the cache would serve a
// wrong answer. It is a SHA-256 of:
//   - the question, normalized ("What is  Bitcoin?" = "what is bitcoin?")
//   - the searched documents: their ids and file hashes (an upload or delete
//     of one of them changes it; other documents don't matter)
//   - the chat model (Groq's answer is not Ollama's)
//   - the system prompt (editing the prompt changes the answers)
//   - the retrieval version (another search finds other chunks)
//
// The cache is only a speed-up: if Redis is down or hangs, chat must still
// work. So every Redis call has a short timeout and errors only get logged.

import { createHash } from "node:crypto";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { redis } from "../db/redis.js";
import { SYSTEM_PROMPT } from "../retrieval/prompt.js";
import { RETRIEVAL_VERSION, type SearchResult } from "../retrieval/search.js";
import { withTimeout } from "../withTimeout.js";

const TTL_SECONDS = 3600;
// A down Redis fails at once (enableOfflineQueue: false), but a half-open
// connection (Docker Desktop keeps port 6379 open) would hang without this.
const REDIS_TIMEOUT_MS = 500;

export interface CachedAnswer {
  answer: string;
  sources: SearchResult[];
  tokens: number; // how many tokens the model streamed the first time
}

const model = config.groq ? `groq:${config.groq.model}` : `ollama:${config.chatModel}`;

// Same question, written differently. Unicode NFKC also turns look-alike
// characters (e.g. full-width letters) into their plain form.
function normalize(question: string): string {
  return question.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

// The searched documents' ids and file hashes, in id order. documentIds
// undefined or [] = all documents. The caller dedupes and sorts the ids; the
// SQL (ANY + ORDER BY id) would give one entry per document anyway, so
// [7, 7] and [7] always get the same key.
async function documentSet(documentIds?: number[]): Promise<string> {
  const { rows } = await pool.query<{ docs: string | null }>(
    `SELECT string_agg(id || ':' || COALESCE(content_hash, ''), ',' ORDER BY id) AS docs
       FROM documents
      WHERE $1::int[] IS NULL OR id = ANY($1)`,
    [documentIds?.length ? documentIds : null],
  );
  return rows[0].docs ?? "";
}

export async function answerCacheKey(question: string, documentIds?: number[]): Promise<string> {
  const parts = {
    q: normalize(question),
    docs: await documentSet(documentIds),
    model,
    prompt: SYSTEM_PROMPT,
    retrieval: RETRIEVAL_VERSION,
  };
  return "answer:" + createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// The cached answer, or null on a miss or when Redis does not answer in time.
export async function getCachedAnswer(key: string): Promise<CachedAnswer | null> {
  try {
    const json = await withTimeout(redis.get(key), REDIS_TIMEOUT_MS);
    return json ? (JSON.parse(json) as CachedAnswer) : null;
  } catch (err) {
    console.error("[cache] read skipped:", (err as Error).message);
    return null;
  }
}

// Never throws: a failed write only means the next ask is not faster.
export async function setCachedAnswer(key: string, value: CachedAnswer): Promise<void> {
  try {
    await withTimeout(redis.set(key, JSON.stringify(value), "EX", TTL_SECONDS), REDIS_TIMEOUT_MS);
  } catch (err) {
    console.error("[cache] write skipped:", (err as Error).message);
  }
}
