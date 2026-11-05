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

export const config = {
  ollamaHost: required("OLLAMA_HOST"),
  chatModel: required("CHAT_MODEL"),
  embedModel: required("EMBED_MODEL"),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
  // Optional: the API server's port. Defaults to 3000.
  port: Number(process.env.PORT ?? 3000),
};
