import { Component, computed, signal } from '@angular/core';
import { ChatPanel } from './chat-panel/chat-panel';
import { UploadPanel } from './upload-panel/upload-panel';

// Same shape as GET /api/health on the server (server/src/routes/health.ts).
interface Health {
  status: 'ok' | 'error';
  db: { ok: boolean; ms: number; error?: string };
  redis: { ok: boolean; ms: number; error?: string };
  ollama: { ok: boolean; ms: number; models?: Record<string, boolean>; error?: string };
}

@Component({
  selector: 'app-root',
  imports: [ChatPanel, UploadPanel],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly health = signal<Health | null>(null);
  // Set when the API can't be reached at all (Express not running).
  protected readonly unreachable = signal<string | null>(null);
  protected readonly modelNames = computed(() =>
    Object.keys(this.health()?.ollama.models ?? {}).join(', '),
  );

  constructor() {
    this.checkHealth();
  }

  protected async checkHealth() {
    this.health.set(null);
    this.unreachable.set(null);
    try {
      // A relative URL: the browser asks the Angular dev server (port 4200),
      // which forwards /api/* to Express on port 3000 (proxy.conf.json).
      // fetch, not HttpClient: the chat stream in Task 6 needs fetch's ReadableStream.
      const res = await fetch('/api/health');
      // A 503 still has a JSON body that says what is down, so read it either way.
      this.health.set(await res.json());
    } catch {
      this.unreachable.set('Cannot reach the API server. Is "npm run dev" running?');
    }
  }
}
