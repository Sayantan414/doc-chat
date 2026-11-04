// A shared connection pool to Postgres.
// A pool keeps a few connections open and reuses them, instead of
// opening a new connection (slow) for every query.

import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// If Postgres drops a connection while it sits idle in the pool (e.g. the
// container stops), pg emits an 'error' event on the pool. With no listener,
// Node throws it and the whole server crashes. Log it instead: the pool
// discards that connection and opens a new one for the next query.
pool.on("error", (err) => {
  console.error("Postgres idle connection error:", err.message);
});
