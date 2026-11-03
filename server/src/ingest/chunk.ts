// Ingestion step 2: split each page into small overlapping chunks.
//
// Why chunks? A small focused piece of text gives a sharper embedding than a
// whole page, and only a few chunks fit in the model's context window.
// Why overlap? If an idea is cut at a chunk border, the overlap means the
// next chunk still contains it in full.

import type { PageText } from "./loadPdf.js";

export interface Chunk {
  page: number;
  chunkIndex: number; // position of this chunk inside its page (0, 1, 2...)
  content: string;
}

export function chunkPages(pages: PageText[], size = 800, overlap = 100): Chunk[] {
  const chunks: Chunk[] = [];

  // Chunks never cross pages, so every chunk has exactly one page to cite.
  for (const { page, text } of pages) {
    // PDFs break lines where the printed line ended, even mid-sentence.
    // \s+ = any run of spaces, tabs or line breaks -> one space.
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) continue; // skip empty pages (e.g. a page that is only an image)

    let start = 0;
    let chunkIndex = 0;
    while (start < clean.length) {
      let end = Math.min(start + size, clean.length);

      // Don't cut in the middle of a sentence or word: move the end back to the
      // last sentence end (". ") or, failing that, the last space. Only accept it
      // if it's past the halfway point, so chunks don't become tiny.
      if (end < clean.length) {
        const window = clean.slice(start, end);
        const sentenceEnd = window.lastIndexOf(". ");
        const space = window.lastIndexOf(" ");
        if (sentenceEnd > size / 2) end = start + sentenceEnd + 1;
        else if (space > size / 2) end = start + space;
      }

      chunks.push({ page, chunkIndex: chunkIndex++, content: clean.slice(start, end).trim() });
      if (end >= clean.length) break; // reached the end of the page

      // Step back `overlap` characters for the next chunk, then forward to the
      // next word start so the overlap doesn't begin with half a word.
      let next = end - overlap;
      const nextSpace = clean.indexOf(" ", next);
      if (nextSpace !== -1 && nextSpace < end) next = nextSpace + 1;
      start = next;
    }
  }

  return chunks;
}
