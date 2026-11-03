// Shows what text we get out of a PDF, page by page.
// Run with: npx tsx server/src/scripts/loadPdf.ts pdfs/bitcoin.pdf

import { loadPdf } from "../ingest/loadPdf.js";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npx tsx server/src/scripts/loadPdf.ts <path-to-pdf>");
  process.exit(1);
}

const pages = await loadPdf(filePath);
console.log(`${filePath}: ${pages.length} pages\n`);

for (const p of pages) {
  console.log(`page ${p.page}: ${p.text.length} characters`);
}

// JSON.stringify shows hidden characters like \n (line breaks) so you can see them.
console.log("\nFirst 400 characters of page 1, exactly as extracted:");
console.log(JSON.stringify(pages[0].text.slice(0, 400)));
