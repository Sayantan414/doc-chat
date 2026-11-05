// SHA-256 of a file's bytes, as 64 hex characters: the file's "fingerprint".
// Same bytes -> always the same hash; one changed byte -> a completely different one.
// The name plays no part, so "bitcoin (1).pdf" hashes the same as "bitcoin.pdf".

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  // Read in pieces (64 KB by default) instead of the whole file at once,
  // so a 20 MB PDF does not need 20 MB of memory just to be hashed.
  for await (const piece of createReadStream(filePath)) {
    hash.update(piece);
  }
  return hash.digest("hex");
}
