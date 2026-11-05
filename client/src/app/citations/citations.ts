import { DecimalPipe } from '@angular/common';
import { Component, computed, input, signal } from '@angular/core';
import { Source } from '../api';

// One chip per page the answer cites. Clicking a chip shows the chunk text from
// that page that the model was given.
interface Citation {
  page: number;
  documentName?: string; // only when the citation names one of the sources' files
  // Chunks from this page among the sources. Can be several (two chunks from
  // page 3, or page 3 of two different PDFs), or none if the model cited a page
  // it was never given (e.g. a topic number like "50." mistaken for a page).
  matches: Source[];
}

@Component({
  selector: 'app-citations',
  imports: [DecimalPipe],
  templateUrl: './citations.html',
  styleUrl: './citations.css',
})
export class Citations {
  readonly answer = input.required<string>();
  readonly sources = input.required<Source[]>();

  protected readonly selectedKey = signal<string | null>(null);

  // Citations in the order the answer first uses them, without repeats.
  protected readonly citations = computed<Citation[]>(() => {
    const sources = this.sources();
    const fileNames = new Set(sources.map((s) => s.documentName));
    const byKey = new Map<string, Citation>();

    for (const match of this.answer().matchAll(CITATION)) {
      const page = Number(match[1]);
      // A name in brackets counts only if it is one of the sources' files,
      // so "[page 3] (see above)" is still just page 3.
      const named = match[2] ?? match[3];
      const documentName = named && fileNames.has(named) ? named : undefined;

      const key = citationKey(page, documentName);
      if (byKey.has(key)) continue;
      byKey.set(key, {
        page,
        documentName,
        matches: sources.filter(
          (s) => s.page === page && (!documentName || s.documentName === documentName),
        ),
      });
    }
    return [...byKey.values()];
  });

  protected readonly selected = computed(() =>
    this.citations().find((c) => this.key(c) === this.selectedKey()),
  );

  protected key(c: Citation) {
    return citationKey(c.page, c.documentName);
  }

  protected toggle(c: Citation) {
    const key = this.key(c);
    this.selectedKey.update((current) => (current === key ? null : key));
  }
}

// The prompt labels chunks "[page 3] (bitcoin.pdf)", and the model copies that in
// different ways. All of these are page 3:
//   [page 3]    [page 3 (bitcoin.pdf)]    [page 3] (bitcoin.pdf)
// Group 1 = page, group 2 = name inside the brackets, group 3 = name after them.
const CITATION = /\[page (\d+)(?: \(([^)\]]+)\))?\](?: \(([^)]+)\))?/gi;

function citationKey(page: number, documentName?: string) {
  return `${documentName ?? ''}#${page}`;
}
