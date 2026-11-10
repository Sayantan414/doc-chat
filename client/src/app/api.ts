// Types and calls for the DocChat API (server/src/routes). All URLs are relative:
// the dev server forwards /api/* to Express (proxy.conf.json).

// GET /api/documents and POST /api/documents
export interface DocumentInfo {
  id: number;
  name: string;
  uploadedAt: string; // ISO date string
  chunks: number;
  // Only in the POST /api/documents response: true when this exact file
  // was uploaded before (under any name) and was not ingested again.
  duplicate?: boolean;
}

// POST /api/documents answers 202 with this for a new file: the PDF waits in
// the server's queue and is ingested in the background.
export interface QueuedUpload {
  jobId: string;
  name: string;
}

// GET /api/jobs/:id and GET /api/jobs (server/src/routes/jobs.ts)
export interface JobInfo {
  id: string;
  name: string;
  // waiting | active | delayed (failed, will retry) | completed | failed
  state: string;
  progress: { done: number; total: number } | null; // chunks embedded so far
  result: { documentId: number; chunkCount: number; duplicate: boolean } | null;
  error: string | null; // why the last attempt failed
  attemptsMade: number; // failed attempts so far
  attempts: number; // the most it will try
}

// One chunk the model was given (the "sources" event of POST /api/chat)
export interface Source {
  documentName: string;
  page: number;
  content: string;
  distance: number; // 0 = same meaning, bigger = less related
}

// The "done" event of POST /api/chat
export interface ChatTimings {
  retrievalMs: number;
  firstTokenMs?: number;
  totalMs: number;
  tokens: number;
  cached?: boolean; // true: answered from the server's answer cache
}

export type ChatEvent =
  | { type: 'connected' } // headers arrived: the server has the question
  | { type: 'token'; text: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'done'; timings: ChatTimings }
  | { type: 'error'; message: string };

// A JSON error before the stream started (e.g. 400), with its status code.
export class ChatRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Reads the Server-Sent Events of POST /api/chat and yields them one by one.
// EventSource can't send a POST body, so we read fetch's ReadableStream ourselves.
// documentIds: search only these documents; undefined = all (not sent at all).
export async function* streamChat(
  question: string,
  signal: AbortSignal,
  documentIds?: number[],
): AsyncGenerator<ChatEvent> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, documentIds }), // JSON drops an undefined field
    signal, // aborting it closes the connection; the server then stops Ollama
  });

  // Before the stream starts, errors are normal JSON responses (e.g. 400).
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null);
    throw new ChatRequestError(res.status, body?.error ?? `Request failed (${res.status})`);
  }
  yield { type: 'connected' };

  // Network chunks don't line up with SSE messages: one chunk can hold half a
  // message or several. So collect text in `buffer` and cut out every complete
  // message, which always ends with an empty line ("\n\n").
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += value;

    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const event = parseSseMessage(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (event) yield event;
    }
  }
}

// "event: token\ndata: \"Hi\"" -> { type: 'token', text: 'Hi' }.
// Lines starting with ":" are comments (the server's ": connected") and are skipped.
function parseSseMessage(message: string): ChatEvent | null {
  let name = 'message';
  let data = '';
  for (const line of message.split('\n')) {
    if (line.startsWith('event: ')) name = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!data) return null;

  const payload = JSON.parse(data);
  switch (name) {
    case 'token':
      return { type: 'token', text: payload };
    case 'sources':
      return { type: 'sources', sources: payload };
    case 'done':
      return { type: 'done', timings: payload };
    case 'error':
      return { type: 'error', message: payload.error };
    default:
      return null;
  }
}
