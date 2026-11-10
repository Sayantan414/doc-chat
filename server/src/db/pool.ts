// A shared connection pool to Postgres.
// A pool keeps a few connections open and reuses them, instead of
// opening a new connection (slow) for every query.

import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// Every new connection: let a filtered HNSW search keep walking the graph until
// enough rows pass the WHERE (pgvector 0.8+). Without it, searching one small
// document returned 2 of its 7 chunks. relaxed_order is faster than
// strict_order; search.ts re-sorts the results itself. A client runs its
// queries in order, so this SET is done before the first real query.
pool.on("connect", (client) => {
  client.query("SET hnsw.iterative_scan = relaxed_order").catch((err) => {
    console.error("Could not enable hnsw.iterative_scan:", err.message);
  });
});

// If Postgres drops a connection while it sits idle in the pool (e.g. the
// container stops), pg emits an 'error' event on the pool. With no listener,
// Node throws it and the whole server crashes. Log it instead: the pool
// discards that connection and opens a new one for the next query.
pool.on("error", (err) => {
  console.error("Postgres idle connection error:", err.message);
});
