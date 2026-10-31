// Step 1, task 5: ask the LLM one question and print the answer as it streams in.
// Run with: npx tsx server/src/scripts/ask.ts "What is a railway signal?"

import { config } from "../config.js";
import type { ChatMessage } from "../llm/LlmProvider.js";
import { OllamaProvider } from "../llm/OllamaProvider.js";

const llm = new OllamaProvider({
  host: config.ollamaHost,
  chatModel: config.chatModel,
  embedModel: config.embedModel,
});

// process.argv = ["node", "ask.ts", "your", "question", ...], so the question starts at index 2.
const question = process.argv.slice(2).join(" ") || "What is a railway signal? Answer in 3 lines.";

const messages: ChatMessage[] = [
  { role: "system", content: "You are a helpful assistant. Keep answers short." },
  { role: "user", content: question },
];

console.log(`You: ${question}\n`);
process.stdout.write("AI: ");

const start = Date.now();
let firstTokenAt = 0;

for await (const token of llm.chat(messages)) {
  if (!firstTokenAt) firstTokenAt = Date.now();
  // stdout.write prints without adding a newline, so the tokens join into sentences.
  process.stdout.write(token);
}

console.log(`\n\n(first token after ${firstTokenAt - start} ms, full answer after ${Date.now() - start} ms)`);
