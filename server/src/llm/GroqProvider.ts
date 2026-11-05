// LlmProvider that writes answers with a model on Groq's servers (online, fast).
// Groq has no embedding models, so embed() is passed on to another provider
// (Ollama): the stored chunk vectors were made with that model.
//
// No SDK: Groq's API is OpenAI-compatible, so it is one fetch() to
// /openai/v1/chat/completions. With stream: true the answer arrives as
// Server-Sent Events -- the same format our own /api/chat sends to the browser.

import type { ChatMessage, ChatOptions, LlmProvider } from "./LlmProvider.js";

const BASE_URL = "https://api.groq.com/openai/v1";
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_S = 10;

// setTimeout as a promise that ends early (with an AbortError) if `signal` aborts,
// so a user who leaves doesn't keep a retry waiting.
function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export interface GroqOptions {
  apiKey: string;
  model: string; // e.g. openai/gpt-oss-20b
  embedder: LlmProvider; // makes the vectors (Ollama with nomic-embed-text)
  embedModel: string; // its model name, for the health check
}

export class GroqProvider implements LlmProvider {
  constructor(private options: GroqOptions) {}

  async *chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
    const isGptOss = this.options.model.startsWith("openai/gpt-oss");
    const body = JSON.stringify({
      model: this.options.model,
      messages,
      stream: true,
      temperature: options?.temperature,
      // gpt-oss models "think" before answering. We only show the answer, and
      // less thinking means the first word arrives sooner.
      ...(isGptOss && { reasoning_effort: "low", include_reasoning: false }),
    });

    let res: Response;
    for (let attempt = 1; ; attempt++) {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        // Aborting (the user left) cancels the request, so Groq stops too.
        signal: options?.signal,
      });
      if (res.ok && res.body) break;

      // Errors arrive before the stream: 401 = wrong key, 429 = rate limit reached.
      const error = await res.json().catch(() => null);
      const retryAfter = Number(res.headers.get("retry-after"));
      const message = `Groq ${res.status}: ${error?.error?.message ?? res.statusText}`;

      // The free plan allows 8000 tokens per minute (~6 questions). That limit frees
      // up within seconds, so wait and try again. Nothing was streamed yet, so a retry
      // is invisible to the user. A long wait (e.g. the daily limit) is an error.
      if (res.status === 429 && retryAfter > 0 && retryAfter <= MAX_RETRY_WAIT_S && attempt < MAX_ATTEMPTS) {
        console.log(`[groq] rate limited, retrying in ${retryAfter} s (attempt ${attempt})`);
        await sleep(retryAfter * 1000, options?.signal);
        continue;
      }
      throw new Error(retryAfter ? `${message} (retry after ${retryAfter} s)` : message);
    }

    // Same buffering as the browser's streamChat(): network chunks don't line up
    // with SSE messages, so cut out each complete "data: ..." message ourselves.
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;

      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const message = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 2);
        if (!message.startsWith("data: ")) continue;

        const data = message.slice(6);
        if (data === "[DONE]") return; // OpenAI-style end of stream
        // Each piece: { choices: [{ delta: { content: "..." } }] }. The first one
        // only says role: "assistant" and has no content.
        const text = JSON.parse(data).choices?.[0]?.delta?.content;
        if (text) yield text;
      }
    }
  }

  embed(text: string): Promise<number[]> {
    return this.options.embedder.embed(text);
  }

  async checkModels(): Promise<Record<string, boolean>> {
    // GET /models lists the models this API key may use; it also checks the key.
    const [res, embedModels] = await Promise.all([
      fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${this.options.apiKey}` } }),
      this.options.embedder.checkModels(),
    ]);
    if (!res.ok) throw new Error(`Groq ${res.status}: ${res.statusText}`);
    const { data } = (await res.json()) as { data: { id: string }[] };

    return {
      [`groq:${this.options.model}`]: data.some((m) => m.id === this.options.model),
      [this.options.embedModel]: embedModels[this.options.embedModel] ?? false,
    };
  }
}
