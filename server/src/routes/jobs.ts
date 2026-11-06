// GET /api/jobs/:id: how one ingest job is doing (the browser polls this).
// GET /api/jobs:     the jobs not finished yet (waiting, active or delayed), so a page
//                    that was refreshed can show them again.

import { Router } from "express";
import type { Job } from "bullmq";
import type { IngestResult } from "../ingest/embed.js";
import { ingestQueue, type IngestJobData, type IngestProgress } from "../queue/ingestQueue.js";
import { httpError } from "./httpError.js";

export const jobsRouter = Router();

// The shape the frontend sees.
export interface JobInfo {
  id: string;
  name: string; // the uploaded file's name
  // waiting = in the queue; active = a worker is on it; delayed = failed and
  // waiting to retry; completed / failed = done.
  state: string;
  progress: IngestProgress | null; // null until the first chunk is embedded
  result: IngestResult | null; // only when completed
  // While "delayed" (waiting to retry): why the last attempt failed.
  // When "failed": why the job gave up.
  error: string | null;
  attemptsMade: number; // attempts that ended in failure so far
  attempts: number; // the most it will try
}

async function toJobInfo(job: Job<IngestJobData, IngestResult>): Promise<JobInfo> {
  // job.progress is 0 (BullMQ's default) until the worker reports an object.
  const progress = typeof job.progress === "object" ? (job.progress as IngestProgress) : null;
  const state = await job.getState();
  return {
    id: job.id!,
    name: job.data.name,
    state,
    progress,
    result: job.returnvalue ?? null,
    // BullMQ keeps the last failure reason even after a retry succeeds,
    // so show it only while it still matters.
    error: state === "failed" || state === "delayed" ? job.failedReason || null : null,
    attemptsMade: job.attemptsMade,
    attempts: job.opts.attempts ?? 1,
  };
}

jobsRouter.get("/jobs", async (_req, res) => {
  // asc = true: oldest first, the order the worker takes them.
  const jobs = await ingestQueue.getJobs(["active", "waiting", "delayed"], 0, -1, true);
  res.json(await Promise.all(jobs.map((job) => toJobInfo(job as Job<IngestJobData, IngestResult>))));
});

jobsRouter.get("/jobs/:id", async (req, res) => {
  const job = await ingestQueue.getJob(req.params.id);
  // Unknown id, or finished long enough ago that BullMQ removed it.
  if (!job) throw httpError(404, `No job ${req.params.id}`);
  res.json(await toJobInfo(job as Job<IngestJobData, IngestResult>));
});
