import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ChatTimings, Source } from './api';

// One question and its answer.
//   sending   = request sent, waiting for the server's headers
//   reading   = server answered "connected": retrieval done, the model reads the prompt
//   streaming = tokens are arriving
export interface ChatTurn {
  question: string;
  answer: string;
  status: 'sending' | 'reading' | 'streaming' | 'done' | 'stopped' | 'error';
  sources: Source[];
  timings?: ChatTimings; // only for answers streamed in this tab, not reopened ones
  error?: string;
  startedAt: number;
}

// GET /api/conversations
export interface ConversationSummary {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

// One message of GET /api/conversations/:id
export interface StoredMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  status: 'done' | 'stopped' | 'error';
  error: string | null;
  sources: Source[] | null;
  createdAt: string;
}

// Stored messages (a flat list) -> chat turns (question + answer pairs).
// A question whose answer was never saved (e.g. the server lost its database
// connection) still shows, with a note instead of an answer.
export function toTurns(messages: StoredMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user') continue; // an answer without its question: nothing to pair it with
    const next = messages[i + 1];
    const startedAt = Date.parse(m.createdAt);
    if (next?.role === 'assistant') {
      turns.push({
        question: m.content,
        answer: next.content,
        status: next.status,
        sources: next.sources ?? [],
        error: next.status === 'error' ? (next.error ?? 'The answer failed.') : undefined,
        startedAt,
      });
      i++;
    } else {
      turns.push({ question: m.content, answer: '', status: 'error', sources: [], error: 'No answer was saved.', startedAt });
    }
  }
  return turns;
}

// The conversation list, the open conversation and its turns. A root service:
// the sidebar list, the "New chat" button and the chat panel all use it.
@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly http = inject(HttpClient);

  readonly conversations = signal<ConversationSummary[]>([]);
  readonly activeId = signal<number | undefined>(undefined);
  readonly turns = signal<ChatTurn[]>([]);
  readonly loading = signal(false); // a conversation is being opened
  readonly error = signal<string | null>(null); // last list/open/delete error, for the sidebar

  // While an answer streams, switching or deleting would mix it into the wrong
  // conversation (and the server answers 409), so the sidebar is disabled.
  readonly busy = computed(() => ['sending', 'reading', 'streaming'].includes(this.turns().at(-1)?.status ?? ''));

  // Every open() gets the next number; only the newest may write its result.
  // Without it, clicking A then B quickly could show A's messages under B
  // when A's response arrives last.
  private openRequest = 0;

  async loadList(): Promise<void> {
    try {
      this.conversations.set(await firstValueFrom(this.http.get<ConversationSummary[]>('/api/conversations')));
    } catch (err) {
      this.error.set(`Could not load conversations: ${errorText(err)}`);
    }
  }

  async open(id: number): Promise<void> {
    if (this.busy()) return;
    const request = ++this.openRequest;
    this.activeId.set(id);
    this.loading.set(true);
    this.error.set(null);
    try {
      const conversation = await firstValueFrom(
        this.http.get<{ messages: StoredMessage[] }>(`/api/conversations/${id}`),
      );
      if (request !== this.openRequest) return; // a newer open() won
      this.turns.set(toTurns(conversation.messages));
    } catch (err) {
      if (request !== this.openRequest) return;
      // 404: deleted meanwhile (e.g. in another tab): drop it and start fresh.
      this.newChat();
      this.error.set(`Could not open the conversation: ${errorText(err)}`);
      if (status(err) === 404) void this.loadList();
    } finally {
      if (request === this.openRequest) this.loading.set(false);
    }
  }

  newChat() {
    if (this.busy()) return;
    this.openRequest++; // an open() still on its way must not fill the new chat
    this.activeId.set(undefined);
    this.turns.set([]);
    this.loading.set(false);
  }

  // Deletes on the server first; only then the list and (if it was open) the chat.
  async remove(id: number): Promise<boolean> {
    if (this.busy()) return false;
    this.error.set(null);
    try {
      await firstValueFrom(this.http.delete(`/api/conversations/${id}`));
    } catch (err) {
      // 404: already gone, so the result is the same as a delete.
      if (status(err) !== 404) {
        this.error.set(`Could not delete the conversation: ${errorText(err)}`);
        return false;
      }
    }
    this.conversations.update((list) => list.filter((c) => c.id !== id));
    if (this.activeId() === id) this.newChat();
    return true;
  }

  // The server created or continued a conversation for the question just sent.
  conversationStarted(id: number) {
    this.activeId.set(id);
    void this.loadList(); // a new one appears at the top at once
  }
}

function status(err: unknown): number | undefined {
  return (err as { status?: number })?.status;
}

// The server sends { "error": "..." } (see the error handler in server/src/index.ts).
function errorText(err: unknown): string {
  const e = err as { error?: { error?: string }; message?: string };
  return e?.error?.error ?? e?.message ?? String(err);
}
