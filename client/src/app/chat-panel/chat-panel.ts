import { DecimalPipe } from '@angular/common';
import { Component, ElementRef, computed, effect, signal, viewChild } from '@angular/core';
import { MarkdownComponent } from 'ngx-markdown';
import { ChatTimings, Source, streamChat } from '../api';
import { Citations } from '../citations/citations';

// One question and its answer.
//   sending   = request sent, waiting for the server's headers
//   reading   = server answered "connected": retrieval done, the model reads the prompt
//   streaming = tokens are arriving
interface ChatTurn {
  question: string;
  answer: string;
  status: 'sending' | 'reading' | 'streaming' | 'done' | 'stopped' | 'error';
  sources: Source[];
  timings?: ChatTimings;
  error?: string;
  startedAt: number;
}

@Component({
  selector: 'app-chat-panel',
  imports: [DecimalPipe, MarkdownComponent, Citations],
  templateUrl: './chat-panel.html',
  styleUrl: './chat-panel.css',
})
export class ChatPanel {
  protected readonly turns = signal<ChatTurn[]>([]);
  protected readonly question = signal('');
  protected readonly busy = computed(() =>
    ['sending', 'reading', 'streaming'].includes(this.turns().at(-1)?.status ?? ''),
  );

  // Ticks once a second while busy, so the template can show "waiting 23 s".
  protected readonly now = signal(Date.now());
  private abort?: AbortController;
  private timer?: ReturnType<typeof setInterval>;

  private readonly messages = viewChild<ElementRef<HTMLElement>>('messages');
  private readonly input = viewChild<ElementRef<HTMLTextAreaElement>>('input');

  // Index of the answer whose Copy button was just clicked (shows "Copied").
  protected readonly copied = signal<number | null>(null);
  private copiedTimer?: ReturnType<typeof setTimeout>;

  // Starting points for the empty chat
  protected readonly suggestions = [
    'Summarize the main points of my documents',
    'What are the key definitions?',
    'List the most important conclusions',
    'What problem does the document solve?',
  ];

  constructor() {
    // Keep the newest text in view: runs whenever turns() changes (every token).
    effect(() => {
      this.turns();
      const el = this.messages()?.nativeElement;
      if (el) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
    });
  }

  protected secondsSince(start: number) {
    return Math.max(0, Math.round((this.now() - start) / 1000));
  }

  protected onInput(event: Event) {
    const el = event.target as HTMLTextAreaElement;
    this.question.set(el.value);
    this.autoGrow();
  }

  // The question box grows with its text, up to max-h-48, then scrolls.
  private autoGrow() {
    const el = this.input()?.nativeElement;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  protected useSuggestion(text: string) {
    this.question.set(text);
    const el = this.input()?.nativeElement;
    if (el) {
      el.value = text;
      el.focus();
      this.autoGrow();
    }
  }

  protected async copy(text: string, index: number) {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(index);
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(null), 1500);
    } catch {
      // clipboard blocked (e.g. not a secure context): nothing to show
    }
  }

  protected onKeydown(event: KeyboardEvent) {
    // Enter sends, Shift+Enter makes a new line.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.ask();
    }
  }

  protected async ask() {
    const question = this.question().trim();
    if (!question || this.busy()) return;

    this.question.set('');
    const el = this.input()?.nativeElement;
    if (el) {
      el.value = '';
      this.autoGrow();
    }
    this.turns.update((turns) => [
      ...turns,
      { question, answer: '', status: 'sending', sources: [], startedAt: Date.now() },
    ]);
    this.abort = new AbortController();
    this.timer = setInterval(() => this.now.set(Date.now()), 1000);

    try {
      for await (const event of streamChat(question, this.abort.signal)) {
        // Each update replaces the last turn with a new object, so the signal
        // notices the change and Angular re-renders just that part (no zone.js).
        switch (event.type) {
          case 'connected':
            this.updateLast((t) => ({ ...t, status: 'reading' }));
            break;
          case 'token':
            this.updateLast((t) => ({ ...t, status: 'streaming', answer: t.answer + event.text }));
            break;
          case 'sources':
            this.updateLast((t) => ({ ...t, sources: event.sources }));
            break;
          case 'done':
            this.updateLast((t) => ({ ...t, status: 'done', timings: event.timings }));
            break;
          case 'error':
            this.updateLast((t) => ({ ...t, status: 'error', error: event.message }));
            break;
        }
      }
      // The stream ended without "done" or "error": the connection broke.
      this.updateLast((t) =>
        t.status === 'done' || t.status === 'error'
          ? t
          : { ...t, status: 'error', error: 'The connection closed before the answer finished.' },
      );
    } catch (err) {
      this.updateLast((t) =>
        this.abort?.signal.aborted
          ? { ...t, status: 'stopped' }
          : { ...t, status: 'error', error: (err as Error).message },
      );
    } finally {
      clearInterval(this.timer);
    }
  }

  // Closing the connection is enough: the server notices and stops Ollama.
  protected stop() {
    this.abort?.abort();
  }

  private updateLast(change: (turn: ChatTurn) => ChatTurn) {
    this.turns.update((turns) => [...turns.slice(0, -1), change(turns[turns.length - 1])]);
  }
}
