// GET  /api/documents: every uploaded PDF, newest first, with its chunk count.
//      A count of 0 (or far fewer than expected) shows that ingestion went wrong.
// POST /api/documents: upload one PDF (multipart field "file").
//      202 + { jobId }: the PDF is queued; a worker ingests it in the background.
//      200 + the earlier document with duplicate: true when the same file
//      (same bytes, any name) was uploaded before. Nothing is queued then.
// DELETE /api/documents/:id: delete one document and its chunks. 204, or 404.

import { unlink } from "node:fs/promises";
import path from "node:path";
import { Router, type RequestHandler } from "express";
import multer from "multer";
import { pool } from "../db/pool.js";
import { findByHash } from "../ingest/embed.js";
import { hashFile } from "../ingest/hashFile.js";
import { ingestQueue } from "../queue/ingestQueue.js";
import { httpError } from "./httpError.js";

export const documentsRouter = Router();

// The shape the frontend sees: camelCase, no database column names.
export interface DocumentInfo {
  id: number;
  name: string;
  uploadedAt: Date; // res.json() writes it as an ISO string
  chunks: number;
}

// All documents, or just one when `id` is given.
async function findDocuments(id?: number): Promise<DocumentInfo[]> {
  // LEFT JOIN keeps documents with no chunks. COUNT(c.id) skips the NULL row
  // such a document gets, so it counts 0 (COUNT(*) would count 1).
  // ::int because COUNT returns bigint, which pg hands back as a string.
  // $1 IS NULL -> no filter, so one query serves both cases.
  const { rows } = await pool.query(
    `SELECT d.id, d.name, d.uploaded_at, COUNT(c.id)::int AS chunks
     FROM documents d
     LEFT JOIN chunks c ON c.document_id = d.id
     WHERE $1::int IS NULL OR d.id = $1
     GROUP BY d.id
     ORDER BY d.uploaded_at DESC`,
    [id ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    uploadedAt: row.uploaded_at,
    chunks: row.chunks,
  }));
}

// multer parses multipart/form-data. dest: saves each file to uploads/ under a
// random name (no clashes between two "report.pdf" uploads); the folder is created if missing.
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  // Browsers send the file name as UTF-8; multer's default (latin1) garbles non-English names.
  defParamCharset: "utf8",
  // mimetype is what the client claims, so this only stops honest mistakes.
  // A fake PDF still gets through and fails later in pdf-parse.
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(httpError(400, `Only PDF files are allowed (got ${file.mimetype})`));
  },
});

// multer's own errors (e.g. LIMIT_FILE_SIZE) have a code but no status,
// so without this they would all become 500.
const uploadPdf: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      err = Object.assign(err, { status: err.code === "LIMIT_FILE_SIZE" ? 413 : 400 });
    }
    next(err);
  });
};

// No try/catch needed: Express 5 catches a rejected promise from an async
// handler and passes it to the error handler, instead of hanging.
documentsRouter.get("/documents", async (_req, res) => {
  res.json(await findDocuments());
});

documentsRouter.post("/documents", uploadPdf, async (req, res) => {
  if (!req.file) throw httpError(400, "No file uploaded (field name: file)");
  // multer gives a path relative to the API's folder (uploadsf9a...). The worker
  // is another process that may start elsewhere, so the job gets the full path.
  const filePath = path.resolve(req.file.path);
  const name = req.file.originalname;

  // The worker deletes the file after ingesting it. Until the job is safely
  // in the queue, this handler owns the file and must delete it on any exit.
  let queued = false;
  try {
    // The duplicate check stays here: it takes milliseconds, so the answer
    // "already uploaded" comes at once instead of after a trip through the queue.
    const earlier = await findByHash(await hashFile(filePath));
    if (earlier) {
      const [document] = await findDocuments(earlier.documentId);
      res.json({ ...document, duplicate: true }); // 200
      return;
    }

    // Only the path and name go into Redis, not the PDF itself.
    const job = await ingestQueue.add("ingest", { filePath, name });
    queued = true;
    // 202 Accepted: "got it, the work happens later". The jobId is the token
    // for asking about it (GET /api/jobs/:id comes in Task 5).
    res.status(202).json({ jobId: job.id, name });
  } finally {
    if (!queued) await unlink(filePath);
  }
});

documentsRouter.delete("/documents/:id", async (req, res) => {
  // Only a plain positive whole number: "12abc" or "-1" is a 400, not a lookup.
  if (!/^\d+$/.test(req.params.id)) throw httpError(400, "Document id must be a number");
  const id = Number(req.params.id);

  // ON DELETE CASCADE (schema.sql) deletes the chunks in the same statement.
  // Its file hash goes too, so the same PDF can be uploaded again later.
  // The answer cache needs nothing: its key includes the document set.
  const { rowCount } = await pool.query("DELETE FROM documents WHERE id = $1", [id]);
  if (rowCount === 0) throw httpError(404, `No document ${id}`);
  res.status(204).end(); // 204 No Content: done, nothing to send back
});
