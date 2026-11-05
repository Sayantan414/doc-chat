import { provideHttpClient } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideMarkdown } from 'ngx-markdown';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Default backend = XMLHttpRequest, which reports upload progress (UploadPanel).
    provideHttpClient(),
    // Renders the answers' Markdown (lists, bold, code) as HTML, sanitized by Angular.
    provideMarkdown(),
  ],
};
