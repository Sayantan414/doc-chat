// Loads settings from the .env file into process.env and exposes them in one typed object.
// Every other file imports `config` from here instead of reading process.env directly.

import dotenv from "dotenv";

// Reads .env from the folder you run the command in (the project root).
// quiet: true hides dotenv's own "injected env" log line.
dotenv.config({ quiet: true });

// Fail fast with a clear message instead of crashing later with "undefined".
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in .env (see .env.example)`);
  }
  return value;
}

// Which model writes the answers. Embeddings always come from Ollama (EMBED_MODEL):
// the stored chunk vectors were made with it, and vectors from another model
// can't be compared with them.
const chatProvider = process.env.CHAT_PROVIDER ?? "ollama";
if (chatProvider !== "ollama" && chatProvider !== "groq") {
  throw new Error(`CHAT_PROVIDER must be "ollama" or "groq" (got "${chatProvider}")`);
}

export const config = {
  ollamaHost: required("OLLAMA_HOST"),
  chatModel: required("CHAT_MODEL"), // the Ollama chat model
  embedModel: required("EMBED_MODEL"),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
  chatProvider,
  // Only needed (and only checked) when CHAT_PROVIDER=groq.
  groq:
    chatProvider === "groq"
      ? { apiKey: required("GROQ_API_KEY"), model: required("GROQ_MODEL") }
      : undefined,
  // Optional: the API server's port. Defaults to 3000.
  port: Number(process.env.PORT ?? 3000),
};
