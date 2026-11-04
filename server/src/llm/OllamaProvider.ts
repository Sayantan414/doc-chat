// LlmProvider implemented with Ollama running on this laptop.
// The `ollama` library is a thin wrapper around Ollama's HTTP API at localhost:11434.

import { Ollama } from "ollama";
import type { ChatMessage, ChatOptions, LlmProvider } from "./LlmProvider.js";

export interface OllamaOptions {
  host: string; // where the Ollama server listens
  chatModel: string; // writes answers, e.g. llama3.2:3b
  embedModel: string; // turns text into vectors, e.g. nomic-embed-text
}

export class OllamaProvider implements LlmProvider {
  private client: Ollama;

  constructor(private options: OllamaOptions) {
    this.client = new Ollama({ host: options.host });
  }

  // `async *` makes this an async generator: each `yield` hands one piece of
  // text to the caller's `for await` loop right away, without waiting for the rest.
  async *chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
    // Stopping the HTTP request to Ollama is what makes Ollama stop generating.
    // The library's own abort only exists once Ollama has started answering, so
    // during the prompt reading (prefill) there is nothing to abort. Instead we give
    // this call its own client whose fetch also listens to our signal: aborting it
    // cancels the request at any moment.
    const stop = new AbortController();
    const signal = options?.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
    const client = new Ollama({
      host: this.options.host,
      fetch: (input, init) =>
        fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }),
    });

    try {
      // stream: true -> Ollama sends the answer back in many small parts
      // instead of one big response at the end.
      const stream = await client.chat({
        model: this.options.chatModel,
        messages,
        stream: true,
        // Ollama's sampling settings. temperature: undefined -> Ollama's default.
        options: { temperature: options?.temperature },
      });

      for await (const part of stream) {
        yield part.message.content;
      }
    } finally {
      // Runs on normal end, on error, and when the caller stops early (break).
      // After a normal end this does nothing; otherwise it cancels the request.
      stop.abort();
    }
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embed({ model: this.options.embedModel, input: text });
    // embed() accepts many texts at once, so it returns a list of vectors. We sent one.
    return response.embeddings[0];
  }

  async checkModels(): Promise<Record<string, boolean>> {
    // GET /api/tags: the models pulled on this machine.
    const { models } = await this.client.list();
    const installed = new Set(models.map((m) => m.name));

    // Ollama adds ":latest" when a name has no tag, so "nomic-embed-text"
    // is listed as "nomic-embed-text:latest". Accept both forms.
    const has = (name: string) => installed.has(name) || installed.has(`${name}:latest`);
    return {
      [this.options.chatModel]: has(this.options.chatModel),
      [this.options.embedModel]: has(this.options.embedModel),
    };
  }
}
