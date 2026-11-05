// The one LLM instance the app uses. CHAT_PROVIDER in .env picks who writes
// the answers; every file that imports `llm` uses it without knowing which.

import { config } from "../config.js";
import { GroqProvider } from "./GroqProvider.js";
import type { LlmProvider } from "./LlmProvider.js";
import { OllamaProvider } from "./OllamaProvider.js";

const ollama = new OllamaProvider({
  host: config.ollamaHost,
  chatModel: config.chatModel,
  embedModel: config.embedModel,
});

// With Groq, Ollama still makes the embeddings (see GroqProvider).
export const llm: LlmProvider = config.groq
  ? new GroqProvider({
      apiKey: config.groq.apiKey,
      model: config.groq.model,
      embedder: ollama,
      embedModel: config.embedModel,
    })
  : ollama;
