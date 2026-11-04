// The DocChat API server. Start it with: npm run dev
// Every route lives under /api so the Angular dev server can later proxy
// /api/* to here without clashing with its own pages.

import express from "express";
import { config } from "./config.js";
import { healthRouter } from "./routes/health.js";

const app = express();

// Parses JSON request bodies into req.body (needed for POST /api/chat later).
app.use(express.json());

app.use("/api", healthRouter);

app.listen(config.port, () => {
  console.log(`DocChat API listening on http://localhost:${config.port}`);
});
