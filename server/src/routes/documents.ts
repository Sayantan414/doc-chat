// GET  /api/documents: every uploaded PDF, newest first, with its chunk count.
//      A count of 0 (or far fewer than expected) shows that ingestion went wrong.
// POST /api/documents: upload one PDF (multipart field "file") and ingest it.

import { unlink } from "node:fs/promises";
import { Router, type RequestHandler } from "express";
import multer from "multer";
import { pool } from "../db/pool.js";
import { ingestPdf } from "../ingest/embed.js";
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

  try {
    // Synchronous for now: the response waits for load -> chunk -> embed -> save
    // (about 1 s per chunk). Node's 300 s requestTimeout only limits RECEIVING the
    // upload, not this processing, so a big PDF is slow but is not cut off.
    const { documentId } = await ingestPdf(req.file.path, req.file.originalname);
    const [document] = await findDocuments(documentId);
    res.status(201).json(document); // 201 Created: a new resource now exists
  } finally {
    // The chunks are in Postgres now (or the upload failed), so the file is no longer needed.
    await unlink(req.file.path);
  }
});
