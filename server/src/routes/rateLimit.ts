// Rate limiting: at most `limit` requests per IP address per time window.
// Protects the chat route (and Groq's free quota) from someone sending
// questions in a loop.
//
// "Fixed window": the clock is cut into windows (12:00:00-12:00:59, ...).
// Each IP gets a counter in Redis per window: INCR adds 1, EXPIRE deletes the
// key when the window is over. Simple and cheap; the catch is that someone can
// send `limit` requests at the end of one window and `limit` more at the start
// of the next.
//
// Kept in Redis (not in a JS Map) so several API processes would share one count.
// If Redis is down the request is let through: a missing limit is better than
// no chat at all.

import type { RequestHandler } from "express";
import { redis } from "../db/redis.js";
import { withTimeout } from "../withTimeout.js";

export function rateLimit(name: string, limit: number, windowSeconds: number): RequestHandler {
  return async (req, res, next) => {
    const nowS = Date.now() / 1000;
    const window = Math.floor(nowS / windowSeconds);
    const resetS = Math.ceil((window + 1) * windowSeconds - nowS); // until the window ends
    // Behind the Angular dev proxy every request comes from the proxy, so in
    // development all browsers share one counter. (A real deployment behind a
    // proxy would set Express's "trust proxy" to see the client's own IP.)
    const key = `ratelimit:${name}:${req.ip}:${window}`;

    let count: number;
    try {
      // MULTI/EXEC: both commands run together, so a key never stays without an expiry.
      // NX: set the expiry only on the first request of the window. Without it every
      // request pushed it back to a full window, keeping the key longer than needed.
      const results = await withTimeout(redis.multi().incr(key).expire(key, resetS, "NX").exec(), 500);
      count = Number(results?.[0]?.[1]);
    } catch (err) {
      console.error(`[rate limit] skipped: ${(err as Error).message}`);
      return next();
    }

    // Standard headers, so a client can see how many requests it has left.
    res.setHeader("RateLimit-Limit", limit);
    res.setHeader("RateLimit-Remaining", Math.max(0, limit - count));
    res.setHeader("RateLimit-Reset", resetS);

    if (count > limit) {
      res.setHeader("Retry-After", resetS);
      // 429 Too Many Requests. Sent as JSON like every other error, so the chat
      // panel shows the message as it is.
      res.status(429).json({ error: `Too many questions: at most ${limit} per minute. Try again in ${resetS} s.` });
      return;
    }
    next();
  };
}
