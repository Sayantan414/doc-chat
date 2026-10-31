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

export interface LlmProvider {
  // Sends the whole conversation and yields the answer piece by piece (tokens)
  // as the model generates them. Read it with: for await (const token of chat(...))
  chat(messages: ChatMessage[]): AsyncIterable<string>;

  // Turns text into a vector (768 numbers for nomic-embed-text).
  embed(text: string): Promise<number[]>;
}
