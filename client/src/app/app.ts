import { Component, computed, inject, signal } from '@angular/core';
import { ChatPanel } from './chat-panel/chat-panel';
import { ConversationList } from './conversation-list/conversation-list';
import { ThemeService } from './theme';
import { UploadPanel } from './upload-panel/upload-panel';

// Same shape as GET /api/health on the server (server/src/routes/health.ts).
interface Health {
  status: 'ok' | 'error';
  db: { ok: boolean; ms: number; error?: string };
  redis: { ok: boolean; ms: number; error?: string };
  llm: { ok: boolean; ms: number; models?: Record<string, boolean>; error?: string };
}

@Component({
  selector: 'app-root',
  imports: [ChatPanel, ConversationList, UploadPanel],
  templateUrl: './app.html',
  styleUrl: './app.css',
  host: {
    // Escape closes the status dropdown, and on phones the documents drawer.
    '(document:keydown.escape)': 'onEscape()',
  },
})
export class App {
  protected readonly theme = inject(ThemeService);

  protected readonly health = signal<Health | null>(null);
  // Set when the API can't be reached at all (Express not running).
  protected readonly unreachable = signal<string | null>(null);
  protected readonly modelNames = computed(() =>
    Object.keys(this.health()?.llm.models ?? {}).join(', '),
  );

  protected readonly healthOpen = signal(false);
  // The documents drawer. On desktop it starts open (or as the user last left
  // it); on phones it starts closed, since there it covers the chat.
  protected readonly docsOpen = signal(isDesktop() ? readDocsPreference() : false);
  // Which list the sidebar shows. Chats first: that is where you return to.
  protected readonly sidebarTab = signal<'chats' | 'docs'>('chats');
  protected readonly tabs = [
    { id: 'chats', label: 'Chats' },
    { id: 'docs', label: 'Documents' },
  ] as const;

  protected readonly overall = computed<'checking' | 'ok' | 'down'>(() => {
    if (this.unreachable()) return 'down';
    const h = this.health();
    if (!h) return 'checking';
    return h.db.ok && h.redis.ok && h.llm.ok ? 'ok' : 'down';
  });

  protected readonly overallLabel = computed(() => {
    if (this.unreachable()) return 'Server offline';
    const h = this.health();
    if (!h) return 'Checking…';
    const down = this.services(h).filter((s) => !s.ok).map((s) => s.name);
    return down.length ? `${down.join(', ')} down` : 'All systems ok';
  });

  constructor() {
    this.checkHealth();
  }

  protected toggleDocs() {
    this.docsOpen.update((open) => !open);
    // Remember the desktop choice only; phones always start closed.
    if (isDesktop()) {
      try {
        localStorage.setItem(DOCS_KEY, String(this.docsOpen()));
      } catch {
        // storage blocked: the choice just isn't remembered
      }
    }
  }

  // On phones the drawer covers the chat: close it once a chat is picked.
  protected onChatPicked() {
    if (!isDesktop()) this.docsOpen.set(false);
  }

  protected onEscape() {
    this.healthOpen.set(false);
    if (!isDesktop()) this.docsOpen.set(false);
  }

  protected services(h: Health) {
    return [
      { name: 'Database', ok: h.db.ok, ms: h.db.ms, error: h.db.error },
      { name: 'Redis', ok: h.redis.ok, ms: h.redis.ms, error: h.redis.error },
      { name: 'Model', ok: h.llm.ok, ms: h.llm.ms, error: h.llm.error ?? 'model missing' },
    ];
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

const DOCS_KEY = 'docchat-docs-open';

// Same breakpoint as Tailwind's md: (48rem = 768px).
function isDesktop(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(min-width: 48rem)').matches;
}

function readDocsPreference(): boolean {
  try {
    return localStorage.getItem(DOCS_KEY) !== 'false';
  } catch {
    return true;
  }
}
