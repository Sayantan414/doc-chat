// Ingestion step 1: read a PDF and get its text, one entry per page.
// We keep pages separate so every chunk can later say which page it came from.

import { readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";

export interface PageText {
  page: number; // 1-based, like the page numbers a reader sees
  text: string;
}

export async function loadPdf(filePath: string): Promise<PageText[]> {
  const data = await readFile(filePath); // the raw bytes of the PDF
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return result.pages.map((p) => ({ page: p.num, text: p.text }));
  } finally {
    // pdf-parse keeps the parsed PDF in memory until we release it.
    // `finally` runs even if getText() throws, so we never leak memory.
    await parser.destroy();
  }
}
