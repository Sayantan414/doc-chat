// A shared connection pool to Postgres.
// A pool keeps a few connections open and reuses them, instead of
// opening a new connection (slow) for every query.

import pg from "pg";
import { config } from "../config.js";

// options: settings Postgres applies while the connection starts, before any
// query. hnsw.iterative_scan lets a filtered HNSW search keep walking the graph
// until enough rows pass the WHERE (pgvector 0.8+). Without it, searching one
// small document returned 2 of its 7 chunks. relaxed_order is faster than
// strict_order; search.ts re-sorts the results itself.
// (Not a SET in pool.on("connect"): that ran next to the first real query,
// which pg 8 warns about and pg 9 will refuse.)
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  options: "-c hnsw.iterative_scan=relaxed_order",
});

// If Postgres drops a connection while it sits idle in the pool (e.g. the
// container stops), pg emits an 'error' event on the pool. With no listener,
// Node throws it and the whole server crashes. Log it instead: the pool
// discards that connection and opens a new one for the next query.
pool.on("error", (err) => {
  console.error("Postgres idle connection error:", err.message);
});
