import { DatePipe } from '@angular/common';
import { Component, inject, output, signal } from '@angular/core';
import { ChatStore, ConversationSummary } from '../chat-store';

// The saved conversations in the sidebar: "New chat", open one, delete one.
@Component({
  selector: 'app-conversation-list',
  imports: [DatePipe],
  templateUrl: './conversation-list.html',
})
export class ConversationList {
  protected readonly chats = inject(ChatStore);
  // The id being deleted right now, to disable its button.
  protected readonly deleting = signal<number | null>(null);
  // Tells the app a chat was picked, so on phones the drawer can close.
  readonly picked = output<void>();

  constructor() {
    void this.chats.loadList();
  }

  protected open(c: ConversationSummary) {
    void this.chats.open(c.id);
    this.picked.emit();
  }

  protected newChat() {
    this.chats.newChat();
    this.picked.emit();
  }

  protected async remove(c: ConversationSummary) {
    // A delete cannot be undone, so ask first (like deleting a document).
    if (!confirm(`Delete the conversation "${c.title}" and its ${c.messageCount} messages?`)) return;
    this.deleting.set(c.id);
    await this.chats.remove(c.id);
    this.deleting.set(null);
  }
}
