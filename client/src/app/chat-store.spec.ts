import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ChatStore, StoredMessage, toTurns } from './chat-store';

let nextId = 1;
const msg = (role: 'user' | 'assistant', content: string, status: StoredMessage['status'] = 'done', error: string | null = null): StoredMessage => ({
  id: nextId++,
  role,
  content,
  status,
  error,
  sources: role === 'assistant' ? [{ documentName: 'a.pdf', page: 2, content: 'text', distance: 0.3 }] : null,
  createdAt: '2026-11-11T10:00:00Z',
});

describe('toTurns (stored messages -> chat turns)', () => {
  it('pairs a question with its answer and keeps the sources', () => {
    const turns = toTurns([msg('user', 'Q1'), msg('assistant', 'A1')]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ question: 'Q1', answer: 'A1', status: 'done' });
    expect(turns[0].sources[0].page).toBe(2);
  });

  it('a stopped answer keeps its partial text', () => {
    const [t] = toTurns([msg('user', 'Q'), msg('assistant', 'half an ans', 'stopped')]);
    expect(t).toMatchObject({ answer: 'half an ans', status: 'stopped' });
  });

  it('an error answer shows its saved error', () => {
    const [t] = toTurns([msg('user', 'Q'), msg('assistant', '', 'error', 'Groq 429: rate limit')]);
    expect(t).toMatchObject({ status: 'error', error: 'Groq 429: rate limit' });
  });

  it('a question without an answer gets a note', () => {
    const turns = toTurns([msg('user', 'Q1'), msg('assistant', 'A1'), msg('user', 'lost'), msg('user', 'Q3'), msg('assistant', 'A3')]);
    expect(turns.map((t) => t.question)).toEqual(['Q1', 'lost', 'Q3']);
    expect(turns[1]).toMatchObject({ status: 'error', error: 'No answer was saved.' });
    expect(turns[2]).toMatchObject({ answer: 'A3', status: 'done' });
  });

  it('two unanswered questions in a row, and one at the end', () => {
    const turns = toTurns([msg('user', 'a'), msg('user', 'b'), msg('user', 'c')]);
    expect(turns.map((t) => [t.question, t.status])).toEqual([['a', 'error'], ['b', 'error'], ['c', 'error']]);
  });

  it('an answer without a question is skipped', () => {
    expect(toTurns([msg('assistant', 'orphan'), msg('user', 'Q'), msg('assistant', 'A')]).map((t) => t.answer)).toEqual(['A']);
  });
});

describe('ChatStore', () => {
  let store: ChatStore;
  let http: HttpTestingController;
  const detail = (question: string) => ({ messages: [msg('user', question), msg('assistant', 'answer to ' + question)] });

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    store = TestBed.inject(ChatStore);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('open() loads the turns and sets the active id', async () => {
    const opening = store.open(5);
    expect(store.loading()).toBe(true);
    http.expectOne('/api/conversations/5').flush(detail('Q5'));
    await opening;
    expect(store.activeId()).toBe(5);
    expect(store.turns().map((t) => t.question)).toEqual(['Q5']);
    expect(store.loading()).toBe(false);
  });

  it('clicking A then B: A answering last must not overwrite B', async () => {
    const openA = store.open(1);
    const openB = store.open(2);
    const [reqA, reqB] = [http.expectOne('/api/conversations/1'), http.expectOne('/api/conversations/2')];
    reqB.flush(detail('B'));
    await openB;
    reqA.flush(detail('A')); // the slow one arrives last
    await openA;
    expect(store.activeId()).toBe(2);
    expect(store.turns().map((t) => t.question)).toEqual(['B']);
    expect(store.loading()).toBe(false);
  });

  it('New chat while an open() is on its way stays empty', async () => {
    const opening = store.open(1);
    store.newChat();
    http.expectOne('/api/conversations/1').flush(detail('A'));
    await opening;
    expect(store.activeId()).toBeUndefined();
    expect(store.turns()).toEqual([]);
  });

  it('opening a deleted conversation (404) shows an error, starts fresh and reloads the list', async () => {
    const opening = store.open(9);
    http.expectOne('/api/conversations/9').flush({ error: 'No conversation 9' }, { status: 404, statusText: 'Not Found' });
    await opening;
    expect(store.activeId()).toBeUndefined();
    expect(store.error()).toContain('No conversation 9');
    http.expectOne('/api/conversations').flush([]);
  });

  it('busy: open, New chat and delete do nothing while an answer streams', async () => {
    store.activeId.set(3);
    store.turns.set([{ question: 'Q', answer: 'par', status: 'streaming', sources: [], startedAt: 0 }]);
    await store.open(4);
    store.newChat();
    expect(await store.remove(3)).toBe(false);
    expect(store.activeId()).toBe(3);
    expect(store.turns()).toHaveLength(1);
    http.expectNone(() => true);
  });

  it('deleting the open conversation removes it from the list and starts a new chat', async () => {
    store.conversations.set([
      { id: 1, title: 'one', createdAt: '', updatedAt: '', messageCount: 2 },
      { id: 2, title: 'two', createdAt: '', updatedAt: '', messageCount: 2 },
    ]);
    store.activeId.set(2);
    store.turns.set([{ question: 'Q', answer: 'A', status: 'done', sources: [], startedAt: 0 }]);
    const removing = store.remove(2);
    const req = http.expectOne('/api/conversations/2');
    expect(req.request.method).toBe('DELETE');
    req.flush(null, { status: 204, statusText: 'No Content' });
    expect(await removing).toBe(true);
    expect(store.conversations().map((c) => c.id)).toEqual([1]);
    expect(store.activeId()).toBeUndefined();
    expect(store.turns()).toEqual([]);
  });

  it('a 409 on delete keeps the conversation and shows why', async () => {
    store.conversations.set([{ id: 1, title: 'one', createdAt: '', updatedAt: '', messageCount: 2 }]);
    const removing = store.remove(1);
    http.expectOne('/api/conversations/1').flush({ error: 'still being written' }, { status: 409, statusText: 'Conflict' });
    expect(await removing).toBe(false);
    expect(store.conversations()).toHaveLength(1);
    expect(store.error()).toContain('still being written');
  });

  it('a 404 on delete counts as deleted (gone already)', async () => {
    store.conversations.set([{ id: 1, title: 'one', createdAt: '', updatedAt: '', messageCount: 2 }]);
    const removing = store.remove(1);
    http.expectOne('/api/conversations/1').flush({ error: 'No conversation 1' }, { status: 404, statusText: 'Not Found' });
    expect(await removing).toBe(true);
    expect(store.conversations()).toEqual([]);
  });
});
