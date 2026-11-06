// The "ingest" queue: uploads are added here as jobs, and a worker (Task 4)
// takes them one by one and runs load -> chunk -> embed -> save.
// BullMQ keeps the jobs in Redis, so they survive a server restart.

import { Queue } from "bullmq";
import { config } from "../config.js";

// What a job carries. Only small data goes into Redis: the PDF stays on disk
// in uploads/ and the job just says where it is.
export interface IngestJobData {
  filePath: string; // the saved upload, e.g. uploads/3f9a...
  name: string; // the original file name, shown in the documents list
}

// What job.progress holds while a job runs (set by the worker, read by GET /api/jobs/:id).
export interface IngestProgress {
  done: number; // chunks embedded so far
  total: number;
}

// BullMQ makes its own Redis connections (not the shared one in db/redis.ts),
// because a worker waits on Redis with blocking commands and needs different
// settings. It takes host/port options, so split REDIS_URL into them.
const url = new URL(config.redisUrl);
export const redisConnection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  password: url.password || undefined,
};

export const ingestQueue = new Queue<IngestJobData>("ingest", {
  connection: {
    ...redisConnection,
    // The API should answer "Redis is down" quickly, not wait for it to come back
    // (BullMQ's advice for code that adds jobs). commandTimeout covers the
    // half-open connection Docker Desktop leaves when Redis stops (see Task 1).
    enableOfflineQueue: false,
    commandTimeout: 5000,
  },
  // BullMQ keeps finished jobs in Redis forever by default. Keep them long
  // enough for the browser to read the result (GET /api/jobs/:id), then let
  // BullMQ delete them. Ages are in seconds.
  defaultJobOptions: {
    // A failed job is tried up to 3 times in all. Between tries it waits
    // (state "delayed"), longer each time: 5 s, then 10 s. A short outage
    // (Ollama restarting, loading a model) is over by then.
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 }, // failures kept longer, to look into
  },
});
