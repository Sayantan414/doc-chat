// Step 1, task 6: a terminal chat that remembers the conversation.
// Run with: npx tsx server/src/scripts/chat.ts   (type "exit" to quit)

import * as readline from "node:readline";
import { config } from "../config.js";
import type { ChatMessage } from "../llm/LlmProvider.js";
import { OllamaProvider } from "../llm/OllamaProvider.js";

const llm = new OllamaProvider({
  host: config.ollamaHost,
  chatModel: config.chatModel,
  embedModel: config.embedModel,
});

// The model is stateless: it only knows what is in this array.
// We keep the whole conversation here and send all of it on every turn.
const messages: ChatMessage[] = [
  { role: "system", content: "You are a helpful assistant. Keep answers short." },
];

// readline reads what you type in the terminal, one line at a time.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt("\nYou: ");

console.log('Chat with the model. Type "exit" to quit.');
rl.prompt();

// Each loop turn waits for one line of input.
for await (const line of rl) {
  const question = line.trim();
  if (question === "exit") break;
  if (!question) {
    rl.prompt();
    continue;
  }

  messages.push({ role: "user", content: question });

  process.stdout.write("AI: ");
  let answer = ""; // collects the tokens so we can save the full reply
  for await (const token of llm.chat(messages)) {
    process.stdout.write(token);
    answer += token;
  }
  process.stdout.write("\n");

  // Save the reply so the next question can refer back to it.
  messages.push({ role: "assistant", content: answer });
  console.log(`(messages sent next turn: ${messages.length + 1})`);

  rl.prompt();
}

rl.close();
