import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { DocumentInfo } from './api';
import { DocumentStore } from './document-store';

const doc = (id: number): DocumentInfo => ({ id, name: `doc${id}.pdf`, uploadedAt: '2026-11-10T00:00:00Z', chunks: 3 });

describe('DocumentStore', () => {
  let store: DocumentStore;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    store = TestBed.inject(DocumentStore);
    store.documents.set([doc(7), doc(8), doc(22)]);
  });

  it('sends no documentIds while everything is checked (= all, same cache entries as before)', () => {
    expect(store.allSelected()).toBe(true);
    expect(store.documentIds()).toBeUndefined();
  });

  it('sends the checked ids after unchecking one', () => {
    store.toggle(8);
    expect(store.isSelected(8)).toBe(false);
    expect(store.documentIds()).toEqual([7, 22]);
  });

  it('toggling twice checks it again', () => {
    store.toggle(8);
    store.toggle(8);
    expect(store.documentIds()).toBeUndefined();
  });

  it('a newly uploaded document is searched without ticking it', () => {
    store.toggle(8);
    store.documents.update((docs) => [...docs, doc(30)]);
    expect(store.documentIds()).toEqual([7, 22, 30]);
  });

  it('an unchecked document that gets deleted no longer counts', () => {
    store.toggle(8);
    store.documents.update((docs) => docs.filter((d) => d.id !== 8));
    expect(store.allSelected()).toBe(true);
    expect(store.documentIds()).toBeUndefined();
  });

  it('nothing checked: noneSelected, so the chat disables Ask (never sends [] = all)', () => {
    [7, 8, 22].forEach((id) => store.toggle(id));
    expect(store.noneSelected()).toBe(true);
    expect(store.documentIds()).toEqual([]);
  });

  it('no documents at all is not "none selected"', () => {
    store.documents.set([]);
    expect(store.noneSelected()).toBe(false);
  });

  it('selectAll checks everything again', () => {
    store.toggle(7);
    store.toggle(22);
    store.selectAll();
    expect(store.documentIds()).toBeUndefined();
  });

  it('load() replaces the list from GET /api/documents', async () => {
    const http = TestBed.inject(HttpTestingController);
    const loading = store.load();
    http.expectOne('/api/documents').flush([doc(7)]);
    await loading;
    expect(store.documents().map((d) => d.id)).toEqual([7]);
    http.verify();
  });
});
