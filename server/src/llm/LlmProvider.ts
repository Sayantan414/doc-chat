// The contract every LLM backend must follow (Ollama now, Gemini or Groq later).
// The rest of the app only talks to this interface, so switching providers
// means writing one new class, not changing every file that calls the LLM.

// Who said a message:
//   system    = instructions for the model ("answer only from the context...")
//   user      = the person asking
//   assistant = the model's earlier replies (sent back so it "remembers")
export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatOptions {
  // 0 = always pick the most likely token (same input -> same answer).
  // Leave it out to use the provider's default (more varied answers).
  temperature?: number;
  // Abort it to stop generating, e.g. when the user closes the tab.
  // Works at any moment, also while the model is still reading the prompt.
  signal?: AbortSignal;
}

export interface LlmProvider {
  // Sends the whole conversation and yields the answer piece by piece (tokens)
  // as the model generates them. Read it with: for await (const token of chat(...))
  // `options` is optional, so existing calls without it keep working.
  chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;

  // Turns text into a vector (768 numbers for nomic-embed-text).
  embed(text: string): Promise<number[]>;

  // For the health check: is each model we use available? e.g. { "llama3.1:8b": true }
  // Throws if the backend can't be reached at all.
  checkModels(): Promise<Record<string, boolean>>;
}
