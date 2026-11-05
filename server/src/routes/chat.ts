// POST /api/chat: answer a question from the documents, streamed with Server-Sent Events.
// Body: { "question": "..." }. Same pipeline as scripts/rag.ts:
// search -> build prompt -> stream the answer -> send the sources.
//
// Events, in order:
//   token   (many) one piece of the answer, as a JSON string
//   sources (once) the chunks the model was given
//   done    (once) timings in ms
//   error   (instead of sources/done) if the model fails mid-answer

import { Router, type Response } from "express";
import { llm } from "../llm/index.js";
import { buildRagMessages } from "../retrieval/prompt.js";
import { searchChunks } from "../retrieval/search.js";
import { httpError } from "./httpError.js";

export const chatRouter = Router();

const MAX_QUESTION_CHARS = 2000;

// One SSE message: "event: <name>", "data: <json>", then an empty line that ends it.
// data is always JSON: a raw token like "\n\n" would otherwise look like the end of a message.
function sendEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

chatRouter.post("/chat", async (req, res) => {
  // req.body is undefined when the request had no JSON body.
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) throw httpError(400, 'Send a JSON body like {"question": "..."}');
  if (question.length > MAX_QUESTION_CHARS) {
    throw httpError(400, `Question is too long (max ${MAX_QUESTION_CHARS} characters)`);
  }

  // Retrieval runs BEFORE the stream starts, so a failure here (e.g. DB down)
  // is still a normal JSON error with a proper status code.
  const start = performance.now();
  const chunks = await searchChunks(question, 5);
  const retrievalMs = Math.round(performance.now() - start);
  const messages = buildRagMessages(question, chunks);

  // From here on the status (200) and headers are sent and can't change.
  // Errors after this point must travel as an "error" event instead.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache", // never store a half-finished stream
    Connection: "keep-alive",
  });
  // Send something right away, so the client knows at once that the answer is on
  // its way. writeHead alone only queues the headers (they went out with the first
  // token: 41.9 s), and flushHeaders() wasn't enough behind the Angular dev proxy,
  // which waits for body bytes (82 s). An SSE comment (a line starting with ":") is
  // real body data that every SSE parser ignores, so headers and all go out now.
  res.write(": connected\n\n");

  // If the client leaves early, abort the model right away so Ollama stops working
  // for nobody (it handles one request at a time, so the next question would wait).
  // "close" also fires after a normal res.end(), so only count it if we hadn't finished.
  const abort = new AbortController();
  let clientGone = false;
  res.on("close", () => {
    if (res.writableEnded) return;
    clientGone = true;
    abort.abort();
  });

  let firstTokenMs: number | undefined;
  let tokens = 0;
  try {
    for await (const token of llm.chat(messages, { temperature: 0, signal: abort.signal })) {
      firstTokenMs ??= Math.round(performance.now() - start);
      tokens++;
      sendEvent(res, "token", token);
    }

    if (!clientGone) {
      const totalMs = Math.round(performance.now() - start);
      sendEvent(res, "sources", chunks);
      sendEvent(res, "done", { retrievalMs, firstTokenMs, totalMs, tokens });
      console.log(`[chat] ${tokens} tokens, retrieval ${retrievalMs} ms, first token ${firstTokenMs} ms, total ${totalMs} ms`);
    }
  } catch (err) {
    if (clientGone) {
      // Expected: our abort makes the model call throw an AbortError.
      const ms = Math.round(performance.now() - start);
      console.log(`[chat] client disconnected after ${tokens} tokens (${ms} ms), generation stopped`);
    } else {
      console.error(err);
      sendEvent(res, "error", { error: (err as Error).message });
    }
  } finally {
    res.end();
  }
});
