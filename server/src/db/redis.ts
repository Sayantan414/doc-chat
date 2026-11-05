// A shared connection to Redis (the "redis" service in docker-compose.yml).
// Redis is an in-memory key-value store; DocChat uses it for the job queue
// and the answer cache.

import { Redis } from "ioredis";
import { config } from "../config.js";

export const redis = new Redis(config.redisUrl, {
  // By default ioredis keeps commands in a queue while Redis is down and sends
  // them after it reconnects, so a call could wait forever. Fail at once instead:
  // a cache that is down should be skipped, not waited for.
  enableOfflineQueue: false,
});

// ioredis reconnects by itself, emitting "error" on every failed attempt (about
// every 2 s). Log only when the state changes, not every retry.
let down = false;
redis.on("error", (err: Error & { code?: string }) => {
  // An AggregateError (::1 and 127.0.0.1 both refused) has an empty message; its code says more.
  if (!down) console.error("Redis connection error:", err.message || err.code || err.name);
  down = true;
});
redis.on("ready", () => {
  if (down) console.log("Redis connection is back");
  down = false;
});
