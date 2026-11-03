// Query step 2 (the "A" in RAG): build the messages for the chat model.
// Final prompt = rules (system) + numbered chunks with page numbers + the question (user).

import type { ChatMessage } from "../llm/LlmProvider.js";
import type { SearchResult } from "./search.js";

// The rules stay the same for every question, so they go in the system message.
export const SYSTEM_PROMPT = `You answer questions about the user's documents.

Rules:
- Use ONLY the information in the context below. Do not use your own knowledge.
- After every fact, cite where it came from like this: [page 5]
- If the context does not contain the answer, reply exactly: I don't know.
- Keep the answer short and clear.`;

// Few-shot example: one worked question + answer, sent as an earlier turn of the chat.
// It contains the trap that fooled the model ("3. Signals" is a section number, not a page)
// and shows the right behaviour: cite the [page N] label, in the exact format, only the
// chunk that was used. It is about railways on purpose, so its facts can't leak into
// answers about the real documents.
const EXAMPLE: ChatMessage[] = [
  {
    role: "user",
    content: `Context:
[page 2] (example.pdf)
3. Signals. A red signal means the train must stop.

[page 5] (example.pdf)
7. Speed limits. The maximum speed in a yard is 15 km/h.

Question: What does a red signal mean?`,
  },
  { role: "assistant", content: "A red signal means the train must stop [page 2]." },
];

export function buildRagMessages(question: string, chunks: SearchResult[]): ChatMessage[] {
  // Label every chunk with exactly the citation format we want ([page N]).
  // Small models copy the patterns they SEE: an extra label like [1], [2] gets copied
  // as a citation instead of the page, so [page N] is the only bracket format here.
  const context = chunks
    .map((c) => `[page ${c.page}] (${c.documentName})\n${c.content}`)
    .join("\n\n");

  // Context and question change every time, so they go in the user message, close together.
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...EXAMPLE,
    { role: "user", content: `Context:\n${context}\n\nQuestion: ${question}` },
  ];
}
