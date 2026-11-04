// The DocChat API server. Start it with: npm run dev
// Every route lives under /api so the Angular dev server can later proxy
// /api/* to here without clashing with its own pages.

import express, { type ErrorRequestHandler } from "express";
import { config } from "./config.js";
import { documentsRouter } from "./routes/documents.js";
import { healthRouter } from "./routes/health.js";

const app = express();

// Parses JSON request bodies into req.body (needed for POST /api/chat later).
app.use(express.json());

app.use("/api", healthRouter);
app.use("/api", documentsRouter);

// Error handler: Express knows it by its 4 parameters and must come after the routes.
// Replaces Express's default HTML page (with a stack trace) by JSON the UI can read.
// The full error stays in the server log only.
const jsonErrors: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  // Some errors carry their own HTTP status, e.g. express.json() sets 400 on a bad body.
  const status = err.status ?? 500;
  res.status(status).json({ error: err.message || err.code || "Internal Server Error" });
};
app.use(jsonErrors);

app.listen(config.port, () => {
  console.log(`DocChat API listening on http://localhost:${config.port}`);
});
