import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DocumentInfo, JobInfo, QueuedUpload } from '../api';

// An upload has two phases in the browser:
//   uploading  = the browser sends the bytes (we get progress events)
//   processing = the server checks for a duplicate and queues the PDF
//                (well under a second)
// After that the PDF is a job on the server; see `jobs` below.
interface UploadState {
  fileName: string;
  phase: 'uploading' | 'processing';
  percent: number;
}

// How often to ask the server about running jobs. Embedding takes about
// 1 s per chunk, so a faster poll would not show more movement.
const POLL_MS = 1000;

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
  // The id of the document being deleted right now, to disable its button.
  protected readonly deleting = signal<number | null>(null);
  // Jobs the server has not finished yet (waiting or active), oldest first.
  protected readonly jobs = signal<JobInfo[]>([]);
  // A file is being dragged over the drop zone.
  protected readonly dragging = signal(false);

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor() {
    this.loadDocuments();

    // After a page refresh the browser has forgotten its jobs, but the server
    // has not: ask which jobs are still running and keep following them.
    this.http.get<JobInfo[]>('/api/jobs').subscribe({
      next: (jobs) => {
        this.jobs.set(jobs);
        this.schedulePoll();
      },
      error: (err: HttpErrorResponse) =>
        this.message.set({ ok: false, text: `Could not load jobs: ${errorText(err)}` }),
    });

    // Stop polling when the component goes away.
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      if (this.pollTimer) clearTimeout(this.pollTimer);
    });
  }

  protected percent(job: JobInfo): number {
    return job.progress ? Math.round((100 * job.progress.done) / job.progress.total) : 0;
  }

  protected onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // so choosing the same file again still fires "change"
    if (file) this.uploadFile(file);
  }

  protected dropZoneClass() {
    if (this.upload()) return 'cursor-not-allowed border-line opacity-60';
    if (this.dragging()) return 'cursor-copy border-accent bg-accent-soft';
    return 'cursor-pointer border-line hover:border-accent hover:bg-accent-soft/50';
  }

  protected onDragOver(event: DragEvent) {
    event.preventDefault(); // allows dropping here
    if (!this.upload()) this.dragging.set(true);
  }

  protected onDrop(event: DragEvent) {
    event.preventDefault(); // stops the browser from opening the PDF itself
    this.dragging.set(false);
    const file = event.dataTransfer?.files[0];
    if (!file || this.upload()) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      this.message.set({ ok: false, text: `${file.name} is not a PDF` });
      return;
    }
    this.uploadFile(file);
  }

  private uploadFile(file: File) {

    // multipart/form-data with the PDF in the field "file" (what multer expects)
    const form = new FormData();
    form.append('file', file);

    this.message.set(null);
    this.upload.set({ fileName: file.name, phase: 'uploading', percent: 0 });

    // observe: 'events' + reportProgress: emit every progress event, not just the result.
    this.http
      .post<DocumentInfo | QueuedUpload>('/api/documents', form, { observe: 'events', reportProgress: true })
      .subscribe({
        next: (event) => {
          if (event.type === HttpEventType.UploadProgress) {
            const percent = event.total ? Math.round((100 * event.loaded) / event.total) : 0;
            // All bytes sent: from now on the server is checking and queueing.
            this.upload.set({
              fileName: file.name,
              phase: percent < 100 ? 'uploading' : 'processing',
              percent,
            });
          } else if (event.type === HttpEventType.Response && event.status === 202) {
            // A new file: the server queued it. Follow the job from here.
            const { jobId, name } = event.body as QueuedUpload;
            this.upload.set(null);
            this.jobs.update((jobs) => [
              ...jobs,
              { id: jobId, name, state: 'waiting', progress: null, result: null, error: null, attemptsMade: 0, attempts: 1 },
            ]);
            this.schedulePoll();
          } else if (event.type === HttpEventType.Response && event.body) {
            // 200: the same file was uploaded before, nothing was queued.
            const doc = event.body as DocumentInfo;
            this.upload.set(null);
            this.message.set({
              ok: true,
              text: `${file.name} was already uploaded as ${doc.name} (${chunkText(doc.chunks)}), so it was skipped`,
            });
          }
        },
        error: (err: HttpErrorResponse) => {
          this.upload.set(null);
          this.message.set({ ok: false, text: `Upload failed: ${errorText(err)}` });
        },
      });
  }

  protected deleteDocument(doc: DocumentInfo) {
    // A delete cannot be undone (the PDF would have to be uploaded and embedded
    // again), so ask first.
    if (!confirm(`Delete ${doc.name} and its ${chunkText(doc.chunks)}?`)) return;

    this.deleting.set(doc.id);
    this.http.delete(`/api/documents/${doc.id}`).subscribe({
      next: () => {
        this.deleting.set(null);
        this.documents.update((documents) => documents.filter((d) => d.id !== doc.id));
        this.message.set({ ok: true, text: `Deleted ${doc.name}` });
      },
      error: (err: HttpErrorResponse) => {
        this.deleting.set(null);
        // 404: already gone (e.g. deleted in another tab), so drop it from the list too.
        if (err.status === 404) {
          this.documents.update((documents) => documents.filter((d) => d.id !== doc.id));
        }
        this.message.set({ ok: false, text: `Could not delete ${doc.name}: ${errorText(err)}` });
      },
    });
  }

  private loadDocuments() {
    this.http.get<DocumentInfo[]>('/api/documents').subscribe({
      next: (documents) => this.documents.set(documents),
      error: (err: HttpErrorResponse) =>
        this.message.set({ ok: false, text: `Could not load documents: ${errorText(err)}` }),
    });
  }

  // One poll at a time: the next one is scheduled only after the previous one
  // has finished, so slow answers never pile up. Nothing runs while no job does.
  private schedulePoll() {
    if (this.pollTimer || this.destroyed || this.jobs().length === 0) return;
    this.pollTimer = setTimeout(async () => {
      await this.poll();
      this.pollTimer = null;
      this.schedulePoll();
    }, POLL_MS);
  }

  private async poll() {
    const updates = await Promise.all(
      this.jobs().map(async (job): Promise<JobInfo> => {
        try {
          return await firstValueFrom(this.http.get<JobInfo>(`/api/jobs/${job.id}`));
        } catch (err) {
          const e = err as HttpErrorResponse;
          // 404: the server no longer knows the job. Anything else (server
          // restarting, network) may pass, so keep the job and try again next time.
          if (e.status === 404) return { ...job, state: 'failed', error: 'the server no longer knows this job' };
          return job;
        }
      }),
    );

    let documentsChanged = false;
    for (const job of updates) {
      if (job.state === 'completed' && job.result) {
        const { chunkCount, duplicate } = job.result;
        this.message.set({
          ok: true,
          text: duplicate
            ? `${job.name} was already uploaded (${chunkText(chunkCount)}), so it was skipped`
            : `✓ ${job.name} is ready (${chunkText(chunkCount)})`,
        });
        documentsChanged ||= !duplicate;
      } else if (job.state === 'failed') {
        this.message.set({ ok: false, text: `Processing ${job.name} failed: ${job.error}` });
      }
    }
    // Merge into the CURRENT list, not the one the poll started with: a file
    // uploaded while the requests were out must not be dropped. Then keep only
    // the jobs that are still running.
    const updated = new Map(updates.map((job) => [job.id, job]));
    this.jobs.update((jobs) =>
      jobs
        .map((job) => updated.get(job.id) ?? job)
        .filter((job) => job.state !== 'completed' && job.state !== 'failed'),
    );
    if (documentsChanged) this.loadDocuments();
  }
}

function chunkText(count: number): string {
  return `${count} ${count === 1 ? 'chunk' : 'chunks'}`;
}

// The server sends { "error": "..." } (see the error handler in server/src/index.ts).
function errorText(err: HttpErrorResponse): string {
  return err.error?.error ?? err.message;
}
