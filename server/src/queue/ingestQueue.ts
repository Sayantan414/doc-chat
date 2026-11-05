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
});
