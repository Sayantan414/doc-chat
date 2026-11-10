import { provideHttpClient } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { MARKED_OPTIONS, provideMarkdown } from 'ngx-markdown';
import { safeMarkedOptions } from './markdown-safety';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Default backend = XMLHttpRequest, which reports upload progress (UploadPanel).
    provideHttpClient(),
    // Renders the answers' Markdown (lists, bold, code) as HTML, sanitized by
    // Angular. safeMarkedOptions: no images and no raw HTML (see markdown-safety.ts).
    provideMarkdown({ markedOptions: { provide: MARKED_OPTIONS, useFactory: safeMarkedOptions } }),
  ],
};
