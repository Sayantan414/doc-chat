import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { DocumentInfo } from '../api';

// An upload has two phases:
//   uploading  = the browser sends the bytes (we get progress events)
//   processing = the server loads, chunks and embeds the PDF (~1 s per chunk);
//                the server reports nothing until it's done, so no percentage
interface UploadState {
  fileName: string;
  phase: 'uploading' | 'processing';
  percent: number;
}

@Component({
  selector: 'app-upload-panel',
  imports: [DatePipe],
  templateUrl: './upload-panel.html',
  styleUrl: './upload-panel.css',
})
export class UploadPanel {
  // HttpClient, not fetch: fetch can't report upload progress, and Angular's
  // default HttpClient backend (XMLHttpRequest) can.
  private readonly http = inject(HttpClient);

  protected readonly documents = signal<DocumentInfo[]>([]);
  protected readonly upload = signal<UploadState | null>(null);
  protected readonly message = signal<{ text: string; ok: boolean } | null>(null);

  constructor() {
    this.http.get<DocumentInfo[]>('/api/documents').subscribe({
      next: (documents) => this.documents.set(documents),
      error: (err: HttpErrorResponse) =>
        this.message.set({ ok: false, text: `Could not load documents: ${errorText(err)}` }),
    });
  }

  protected onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // so choosing the same file again still fires "change"
    if (!file) return;

    // multipart/form-data with the PDF in the field "file" (what multer expects)
    const form = new FormData();
    form.append('file', file);

    this.message.set(null);
    this.upload.set({ fileName: file.name, phase: 'uploading', percent: 0 });

    // observe: 'events' + reportProgress: emit every progress event, not just the result.
    this.http
      .post<DocumentInfo>('/api/documents', form, { observe: 'events', reportProgress: true })
      .subscribe({
        next: (event) => {
          if (event.type === HttpEventType.UploadProgress) {
            const percent = event.total ? Math.round((100 * event.loaded) / event.total) : 0;
            // All bytes sent: from now on the server is working on the PDF.
            this.upload.set({
              fileName: file.name,
              phase: percent < 100 ? 'uploading' : 'processing',
              percent,
            });
          } else if (event.type === HttpEventType.Response && event.body) {
            const doc = event.body;
            this.upload.set(null);
            const chunks = `${doc.chunks} ${doc.chunks === 1 ? 'chunk' : 'chunks'}`;
            if (doc.duplicate) {
              // Already in the list, so don't add it again.
              this.message.set({
                ok: true,
                text: `${file.name} was already uploaded as ${doc.name} (${chunks}), so it was skipped`,
              });
            } else {
              this.message.set({ ok: true, text: `Added ${doc.name} (${chunks})` });
              this.documents.update((documents) => [doc, ...documents]);
            }
          }
        },
        error: (err: HttpErrorResponse) => {
          this.upload.set(null);
          this.message.set({ ok: false, text: `Upload failed: ${errorText(err)}` });
        },
      });
  }
}

// The server sends { "error": "..." } (see the error handler in server/src/index.ts).
function errorText(err: HttpErrorResponse): string {
  return err.error?.error ?? err.message;
}
