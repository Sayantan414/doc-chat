// A shared connection pool to Postgres.
// A pool keeps a few connections open and reuses them, instead of
// opening a new connection (slow) for every query.

import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });
