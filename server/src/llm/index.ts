// The one LLM instance the app uses. Swap OllamaProvider for another
// LlmProvider here and every file that imports `llm` uses the new one.

import { config } from "../config.js";
import type { LlmProvider } from "./LlmProvider.js";
import { OllamaProvider } from "./OllamaProvider.js";

export const llm: LlmProvider = new OllamaProvider({
  host: config.ollamaHost,
  chatModel: config.chatModel,
  embedModel: config.embedModel,
});
