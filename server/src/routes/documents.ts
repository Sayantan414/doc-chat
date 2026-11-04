// GET /api/documents: every uploaded PDF, newest first, with its chunk count.
// A count of 0 (or far fewer than expected) shows that ingestion went wrong.

import { Router } from "express";
import { pool } from "../db/pool.js";

export const documentsRouter = Router();

// The shape the frontend sees: camelCase, no database column names.
export interface DocumentInfo {
  id: number;
  name: string;
  uploadedAt: Date; // res.json() writes it as an ISO string
  chunks: number;
}

// No try/catch needed: Express 5 catches a rejected promise from an async
// handler and passes it to the error handler (500), instead of hanging.
documentsRouter.get("/documents", async (_req, res) => {
  // LEFT JOIN keeps documents with no chunks. COUNT(c.id) skips the NULL row
  // such a document gets, so it counts 0 (COUNT(*) would count 1).
  // ::int because COUNT returns bigint, which pg hands back as a string.
  const { rows } = await pool.query(`
    SELECT d.id, d.name, d.uploaded_at, COUNT(c.id)::int AS chunks
    FROM documents d
    LEFT JOIN chunks c ON c.document_id = d.id
    GROUP BY d.id
    ORDER BY d.uploaded_at DESC
  `);

  const documents: DocumentInfo[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    uploadedAt: row.uploaded_at,
    chunks: row.chunks,
  }));
  res.json(documents);
});
