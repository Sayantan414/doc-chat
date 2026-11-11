// POST /api/chat: answer a question from the documents, streamed with Server-Sent Events.
// Body: { "question": "...", "documentIds": [7, 8], "conversationId": 12 }.
// documentIds is optional: missing or [] = search all documents.
// conversationId is optional: missing = a new conversation. The question and
// the answer are saved in Postgres (history/conversations.ts). A conversation
// that is still being answered rejects a second question with 409.
// Same pipeline as scripts/rag.ts:
// search -> build prompt -> stream the answer -> send the sources.
//
// Events, in order:
//   conversation (once) {"id": 12}: the conversation this turn belongs to
//   token   (many) one piece of the answer, as a JSON string
//   sources (once) the chunks the model was given
//   done    (once) timings in ms; cached: true when the answer came from Redis
//   error   (instead of sources/done) if the model fails mid-answer
//
// A repeated question is answered from the answer cache (cache/answerCache.ts):
// the whole answer arrives as one token event, then sources and done as usual.

import { Router, type Response } from "express";
import { answerCacheKey, getCachedAnswer, setCachedAnswer } from "../cache/answerCache.js";
import { llm } from "../llm/index.js";
import { buildRagMessages } from "../retrieval/prompt.js";
import { searchChunks } from "../retrieval/search.js";
import { pool } from "../db/pool.js";
import { finishTurn, startTurn, type AssistantMessage } from "../history/conversations.js";
import { httpError } from "./httpError.js";
import { rateLimit } from "./rateLimit.js";

export const chatRouter = Router();

const MAX_QUESTION_CHARS = 2000;
const MAX_DOCUMENT_IDS = 100;
// documents.id is SERIAL (a 4-byte int). A bigger number made Postgres throw
// "out of range for type integer", which came back as a 500.
const MAX_ID = 2_147_483_647;

// documentIds from the body -> sorted, without duplicates ([8, 7, 7] -> [7, 8]),
// so the same selection always gives the same cache key. undefined = all.
function parseDocumentIds(value: unknown): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((id) => Number.isInteger(id) && id > 0 && id <= MAX_ID)) {
    throw httpError(400, "documentIds must be an array of positive integer document ids");
  }
  if (value.length > MAX_DOCUMENT_IDS) {
    throw httpError(400, `Too many documentIds (max ${MAX_DOCUMENT_IDS})`);
  }
  const ids = [...new Set(value as number[])].sort((a, b) => a - b);
  return ids.length ? ids : undefined;
}

// A stale UI could send ids of deleted documents. Say so, instead of searching
// nothing and answering "I don't know".
async function checkDocumentsExist(ids: number[]) {
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM documents WHERE id = ANY($1)", [ids]);
  const found = new Set(rows.map((r) => r.id));
  const unknown = ids.filter((id) => !found.has(id));
  if (unknown.length) throw httpError(400, `Unknown document id(s): ${unknown.join(", ")}`);
}

// 20 questions per minute per IP. Cache hits count too: the limit is about
// requests, and checking it first is cheaper than finding out what they are.
const chatRateLimit = rateLimit("chat", 20, 60);

// One SSE message: "event: <name>", "data: <json>", then an empty line that ends it.
// data is always JSON: a raw token like "\n\n" would otherwise look like the end of a message.
function sendEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Sends the SSE headers and a first comment line.
function startStream(res: Response) {
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
}

// conversationId from the body: missing = start a new conversation.
function parseConversationId(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > MAX_ID) {
    throw httpError(400, "conversationId must be a positive integer");
  }
  return value as number;
}

chatRouter.post("/chat", chatRateLimit, async (req, res) => {
  // req.body is undefined when the request had no JSON body.
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) throw httpError(400, 'Send a JSON body like {"question": "..."}');
  if (question.length > MAX_QUESTION_CHARS) {
    throw httpError(400, `Question is too long (max ${MAX_QUESTION_CHARS} characters)`);
  }
  const documentIds = parseDocumentIds(req.body.documentIds);
  if (documentIds) await checkDocumentsExist(documentIds);

  // Saves the question and marks the conversation busy; 404 / 409 here are
  // still normal JSON errors, because the stream hasn't started.
  const conversationId = await startTurn(parseConversationId(req.body.conversationId), question, documentIds);

  const start = performance.now();
  // What gets saved as the assistant message in `finally`, whatever happens.
  const turn: AssistantMessage = { content: "", status: "error", documentIds };
  let streaming = false;
  let clientGone = false;
  const abort = new AbortController();
  // The last events (sources + done, or error) are sent AFTER the answer is
  // saved: a client that asks its next question right after "done" must find
  // the conversation free already, or it would get a 409.
  let lastEvents: (() => void) | undefined;

  // Headers, the ": connected" comment, then which conversation this is.
  const openStream = () => {
    startStream(res);
    streaming = true;
    sendEvent(res, "conversation", { id: conversationId });
    // If the client leaves early, abort the model right away so it stops working
    // for nobody. "close" also fires after a normal res.end(), so only count it
    // if we hadn't finished.
    res.on("close", () => {
      if (res.writableEnded) return;
      clientGone = true;
      abort.abort();
    });
  };

  try {
    // Cache first: on a hit nothing else is needed (no embedding, search or model).
    const cacheKey = await answerCacheKey(question, documentIds);
    const cached = await getCachedAnswer(cacheKey);
    if (cached) {
      openStream();
      const ms = Math.round(performance.now() - start);
      sendEvent(res, "token", cached.answer);
      Object.assign(turn, { content: cached.answer, status: "done", sources: cached.sources, cached: true });
      lastEvents = () => {
        sendEvent(res, "sources", cached.sources);
        sendEvent(res, "done", { retrievalMs: 0, firstTokenMs: ms, totalMs: ms, tokens: cached.tokens, cached: true });
      };
      console.log(`[chat] cache hit in ${ms} ms`);
      return;
    }

    // Retrieval runs BEFORE the stream starts, so a failure here (e.g. DB down)
    // is still a normal JSON error with a proper status code.
    const chunks = await searchChunks(question, 5, documentIds);
    turn.sources = chunks;
    const retrievalMs = Math.round(performance.now() - start);
    const messages = buildRagMessages(question, chunks);

    // From here on the status (200) and headers are sent and can't change.
    // Errors after this point must travel as an "error" event instead.
    openStream();

    let firstTokenMs: number | undefined;
    let tokens = 0;
    try {
      for await (const token of llm.chat(messages, { temperature: 0, signal: abort.signal })) {
        firstTokenMs ??= Math.round(performance.now() - start);
        tokens++;
        turn.content += token;
        sendEvent(res, "token", token);
      }
      if (clientGone) {
        turn.status = "stopped";
      } else {
        turn.status = "done";
        const totalMs = Math.round(performance.now() - start);
        lastEvents = () => {
          sendEvent(res, "sources", chunks);
          sendEvent(res, "done", { retrievalMs, firstTokenMs, totalMs, tokens });
        };
        console.log(`[chat] ${tokens} tokens, retrieval ${retrievalMs} ms, first token ${firstTokenMs} ms, total ${totalMs} ms`);
        // Only a complete answer is cached (not a stopped or failed one).
        // Not awaited: the client should not wait for Redis.
        void setCachedAnswer(cacheKey, { answer: turn.content, sources: chunks, tokens });
      }
    } catch (err) {
      if (clientGone) {
        // Expected: our abort makes the model call throw an AbortError.
        turn.status = "stopped";
        const ms = Math.round(performance.now() - start);
        console.log(`[chat] client disconnected after ${tokens} tokens (${ms} ms), generation stopped`);
      } else {
        console.error(err);
        turn.status = "error";
        turn.error = (err as Error).message;
        lastEvents = () => sendEvent(res, "error", { error: turn.error });
      }
    }
  } catch (err) {
    // Before the stream: cache key, retrieval (DB, Ollama). Saved as an error
    // message below, then the JSON error handler answers.
    turn.status = "error";
    turn.error = (err as Error).message;
    if (!streaming) throw err;
    console.error(err);
    lastEvents = () => sendEvent(res, "error", { error: turn.error });
  } finally {
    // Always saved (done, stopped or error), and the conversation is free
    // again. finishTurn never throws: a failed save is only logged.
    await finishTurn(conversationId, turn);
    if (streaming) {
      if (!clientGone) lastEvents?.();
      res.end();
    }
  }
});
