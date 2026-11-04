// GET /api/health: is the app able to work right now?
// Express being up is not enough: we also need Postgres (the ragdb container)
// and Ollama with both models pulled. Checks each one for real.

import { Router } from "express";
import { pool } from "../db/pool.js";
import { llm } from "../llm/index.js";

export const healthRouter = Router();

// A check that hangs would make /health hang too, so give up after `ms`.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

// Runs one check and measures how long it took. Never throws:
// a failure becomes { ok: false, error } so the other check still reports.
async function timed<T>(check: () => Promise<T>) {
  const start = performance.now();
  try {
    const result = await withTimeout(check(), 2000);
    return { ok: true, ms: Math.round(performance.now() - start), result };
  } catch (err) {
    // Some errors have an empty message (e.g. an AggregateError when both
    // ::1 and 127.0.0.1 refuse the connection); their code says more.
    const e = err as Error & { code?: string };
    return { ok: false, ms: Math.round(performance.now() - start), error: e.message || e.code || e.name };
  }
}

healthRouter.get("/health", async (_req, res) => {
  // Both checks run at the same time, so the endpoint takes max(db, ollama), not the sum.
  const [db, ollama] = await Promise.all([
    timed(() => pool.query("SELECT 1")),
    timed(() => llm.checkModels()),
  ]);

  // Reachable but a model not pulled still counts as a failure.
  const models = ollama.ok ? (ollama.result as Record<string, boolean>) : undefined;
  const ollamaOk = ollama.ok && Object.values(models!).every(Boolean);
  const allOk = db.ok && ollamaOk;

  // 503 Service Unavailable tells clients (and the UI later) "up, but can't serve".
  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "error",
    db: { ok: db.ok, ms: db.ms, error: db.error },
    ollama: { ok: ollamaOk, ms: ollama.ms, models, error: ollama.error },
  });
});
