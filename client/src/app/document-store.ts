import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DocumentInfo } from './api';

// The document list and which documents the chat searches. A root service,
// because the list is shown in UploadPanel but read by ChatPanel (siblings).
//
// It stores the UNchecked ids, not the checked ones: a newly uploaded PDF is
// then searched without the user ticking it, and a deleted document's id
// simply stops mattering.
@Injectable({ providedIn: 'root' })
export class DocumentStore {
  private readonly http = inject(HttpClient);

  readonly documents = signal<DocumentInfo[]>([]);
  private readonly excluded = signal<ReadonlySet<number>>(new Set());

  readonly selected = computed(() => this.documents().filter((d) => !this.excluded().has(d.id)));
  readonly allSelected = computed(() => this.selected().length === this.documents().length);
  readonly noneSelected = computed(() => this.documents().length > 0 && this.selected().length === 0);

  // What to send as documentIds: undefined = all documents (the server's
  // default, and the same cache entries as before), otherwise the checked ids.
  readonly documentIds = computed(() => (this.allSelected() ? undefined : this.selected().map((d) => d.id)));

  isSelected(id: number): boolean {
    return !this.excluded().has(id);
  }

  toggle(id: number) {
    this.excluded.update((ids) => {
      const next = new Set(ids);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  selectAll() {
    this.excluded.set(new Set());
  }

  // Rejects with the HttpErrorResponse, so the caller decides how to show it.
  async load(): Promise<void> {
    this.documents.set(await firstValueFrom(this.http.get<DocumentInfo[]>('/api/documents')));
  }
}
