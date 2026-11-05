import { TestBed } from '@angular/core/testing';
import { Source } from '../api';
import { Citations } from './citations';

const source = (documentName: string, page: number): Source => ({
  documentName,
  page,
  content: `text of ${documentName} page ${page}`,
  distance: 0.2,
});

// Renders <app-citations> and returns the chip labels.
async function chips(answer: string, sources: Source[]) {
  const fixture = TestBed.createComponent(Citations);
  fixture.componentRef.setInput('answer', answer);
  fixture.componentRef.setInput('sources', sources);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return [...el.querySelectorAll('.chip')].map((c) => c.textContent!.replace(/\s+/g, ' ').trim());
}

describe('Citations', () => {
  const sources = [source('bitcoin.pdf', 3), source('angular-qa.pdf', 3), source('test.pdf', 1)];

  // The three forms seen from llama3.2:3b in the browser tests.
  it('reads [page N]', async () => {
    expect(await chips('Blocks are chained [page 3].', sources)).toEqual(['page 3']);
  });

  it('reads [page N (file)] and keeps only that file', async () => {
    expect(await chips('It is "pineapple" [page 1 (test.pdf)].', sources)).toEqual([
      'page 1 · test.pdf',
    ]);
  });

  it('reads [page N] (file)', async () => {
    expect(await chips('Proof-of-work ... [page 3] (bitcoin.pdf)', sources)).toEqual([
      'page 3 · bitcoin.pdf',
    ]);
  });

  it('reads [page N] with a narrow no-break space (gpt-oss on Groq)', async () => {
    expect(await chips('Blocks are chained [page 3].', sources)).toEqual(['page 3']);
  });

  it('reads full-width brackets 【page N】 (gpt-oss on Groq)', async () => {
    expect(await chips('Rendered on the server【page 3】.', sources)).toEqual(['page 3']);
  });

  it('ignores a name in brackets that is not a source file', async () => {
    expect(await chips('See [page 3] (see above).', sources)).toEqual(['page 3']);
  });

  it('shows each citation once, in order of first use', async () => {
    expect(await chips('A [page 3]. B [page 1]. C [page 3].', sources)).toEqual([
      'page 3',
      'page 1',
    ]);
  });

  it('marks a page that no source chunk comes from', async () => {
    expect(await chips('Topic 50 says ... [page 50].', sources)).toEqual(['page 50 ⚠']);
  });

  it('shows all matching chunks when the page exists in two files', async () => {
    const fixture = TestBed.createComponent(Citations);
    fixture.componentRef.setInput('answer', 'Something [page 3].');
    fixture.componentRef.setInput('sources', sources);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('.chip') as HTMLButtonElement).click();
    await fixture.whenStable();
    const captions = [...el.querySelectorAll('figcaption')].map((c) => c.textContent!.trim());
    expect(captions.length).toBe(2);
    expect(captions[0]).toContain('bitcoin.pdf, page 3');
    expect(captions[1]).toContain('angular-qa.pdf, page 3');
  });
});
