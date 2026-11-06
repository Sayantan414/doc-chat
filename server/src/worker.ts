// The ingest worker: a separate process that takes PDF jobs from the "ingest"
// queue (filled by POST /api/documents) and runs load -> chunk -> embed -> save.
// Start it next to the API with: npm run worker
//
// Separate from the API so that heavy ingesting never slows down chat answers,
// and a restart of the API (tsx watch) does not stop an ingest halfway.

import { unlink } from "node:fs/promises";
import { Worker, type Job } from "bullmq";
import { pool } from "./db/pool.js";
import { ingestPdf, type IngestResult } from "./ingest/embed.js";
import { redisConnection, type IngestJobData, type IngestProgress } from "./queue/ingestQueue.js";

async function processJob(job: Job<IngestJobData>): Promise<IngestResult> {
  const { filePath, name } = job.data;
  console.log(`Job ${job.id}: ingesting ${name}`);
  const result = await ingestPdf(filePath, name, (done, total) =>
    job.updateProgress({ done, total } satisfies IngestProgress),
  );
  // The chunks are in Postgres now, so the uploaded file is no longer needed.
  await unlink(filePath);
  // BullMQ stores the returned value in Redis as the job's result.
  return result;
}

const worker = new Worker<IngestJobData, IngestResult>("ingest", processJob, {
  connection: redisConnection,
  // One job at a time: two embeddings at once on this CPU-only laptop would
  // each run at about half speed, so both would finish later.
  concurrency: 1,
});

worker.on("ready", () => console.log("Ingest worker waiting for jobs"));

worker.on("completed", (job, result) => {
  const what = result.duplicate ? "already ingested as" : "saved as";
  console.log(`Job ${job.id}: ${job.data.name} ${what} document ${result.documentId} (${result.chunkCount} chunks)`);
});

worker.on("failed", async (job, err) => {
  if (!job) return;
  console.error(`Job ${job.id}: ${job.data.name} failed: ${err.message}`);
  // Keep the file while BullMQ may still retry the job (retries come in Task 6);
  // delete it once the last attempt has failed.
  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade >= attempts) {
    await unlink(job.data.filePath).catch(() => {}); // may already be gone
  }
});

// Errors of the worker itself (e.g. Redis unreachable), not of a job.
// Without a listener Node would treat them as unhandled.
worker.on("error", (err: Error & { code?: string }) => {
  console.error("Worker error:", err.message || err.code || err.name);
});

// Ctrl+C: stop taking new jobs, let the current one finish, then exit.
// If the process is killed instead, the job's lock in Redis expires and
// BullMQ hands the job out again as "stalled" when a worker runs next.
async function shutdown(signal: string) {
  console.log(`${signal}: finishing the current job, then stopping`);
  await worker.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
