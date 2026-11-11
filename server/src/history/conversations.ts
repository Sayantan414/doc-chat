// Chat history in Postgres: conversations and their messages (schema.sql).
// Used by routes/chat.ts (saving) and routes/conversations.ts (reading).

import { pool } from "../db/pool.js";
import type { SearchResult } from "../retrieval/search.js";
import { httpError } from "../routes/httpError.js";

const TITLE_CHARS = 80;
// A conversation stays "busy" this long at most: if the server crashed while
// answering, answering_since was never cleared, and the chat would be stuck.
const BUSY_TIMEOUT = "5 minutes";

// Starts a question: a new conversation (no id) or an existing one, marked as
// busy, plus the user's message. One transaction, so a failure leaves nothing
// half-saved. Throws 404 (no such conversation) or 409 (an answer to it is
// still being written). The conditional UPDATE is one atomic statement: two
// questions at the same moment can't both see "free".
export async function startTurn(
  conversationId: number | undefined,
  question: string,
  documentIds: number[] | undefined,
): Promise<{ conversationId: number; userMessageId: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let id: number;
    if (conversationId === undefined) {
      const title = question.length > TITLE_CHARS ? question.slice(0, TITLE_CHARS - 1) + "…" : question;
      const { rows } = await client.query<{ id: number }>(
        "INSERT INTO conversations (title, answering_since) VALUES ($1, now()) RETURNING id",
        [title],
      );
      id = rows[0].id;
    } else {
      const { rows } = await client.query<{ id: number }>(
        `UPDATE conversations SET answering_since = now()
          WHERE id = $1
            AND (answering_since IS NULL OR answering_since < now() - $2::interval)
          RETURNING id`,
        [conversationId, BUSY_TIMEOUT],
      );
      if (rows.length === 0) {
        // Not updated: either it doesn't exist, or it is busy.
        const exists = await client.query("SELECT 1 FROM conversations WHERE id = $1", [conversationId]);
        throw exists.rowCount
          ? httpError(409, "An answer in this conversation is still being written. Wait for it or stop it first.")
          : httpError(404, `No conversation ${conversationId}`);
      }
      id = conversationId;
    }
    const inserted = await client.query<{ id: number }>(
      "INSERT INTO messages (conversation_id, role, content, document_ids) VALUES ($1, 'user', $2, $3) RETURNING id",
      [id, question, documentIds ?? null],
    );
    await client.query("COMMIT");
    return { conversationId: id, userMessageId: inserted.rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface AssistantMessage {
  content: string;
  searchQuery?: string; // what was really searched (the rewritten follow-up)
  status: "done" | "stopped" | "error";
  error?: string;
  sources?: SearchResult[];
  documentIds?: number[];
  cached?: boolean;
}

// Saves the answer (whatever state it ended in) and marks the conversation as
// free again. Never throws: called from a finally block after the stream, when
// nothing can be sent to the client any more; a failed save is only logged.
export async function finishTurn(conversationId: number, message: AssistantMessage): Promise<void> {
  const logFailure = (err: unknown) =>
    console.error(`[history] could not save the answer of conversation ${conversationId}:`, errorText(err));
  const client = await pool.connect().catch((err) => {
    logFailure(err);
    return null;
  });
  if (!client) return;
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO messages (conversation_id, role, content, status, error, sources, document_ids, cached, search_query)
       VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7, $8)`,
      [
        conversationId,
        message.content,
        message.status,
        message.error ?? null,
        message.sources ? JSON.stringify(message.sources) : null,
        message.documentIds ?? null,
        message.cached ?? false,
        message.searchQuery ?? null,
      ],
    );
    await client.query("UPDATE conversations SET answering_since = NULL WHERE id = $1", [conversationId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logFailure(err);
  } finally {
    client.release();
  }
}

// A refused connection is an AggregateError with an empty message; its code
// (ECONNREFUSED) says what happened.
function errorText(err: unknown): string {
  const e = err as { message?: string; code?: string };
  return e.message || e.code || String(err);
}

export interface HistoryTurn {
  question: string;
  answer: string;
}

// The last `maxTurns` COMPLETE turns before message `beforeMessageId`, oldest
// first: a user message directly followed by an assistant answer with status
// 'done'. Skipped: a question without an answer (e.g. the save failed), an
// 'error' answer, and a 'stopped' (half-written) answer, together with its
// question. Long answers are cut, to keep the prompt within Groq's token limits.
export async function loadHistory(
  conversationId: number,
  beforeMessageId: number,
  maxTurns = 3,
  maxAnswerChars = 600,
): Promise<HistoryTurn[]> {
  // Only the last messages are read: 10 per wanted turn leaves room for
  // skipped ones (failed or stopped answers) without reading a whole long chat.
  const { rows } = await pool.query<{ role: string; content: string; status: string }>(
    `SELECT role, content, status FROM messages
      WHERE conversation_id = $1 AND id < $2
      ORDER BY id DESC LIMIT $3`,
    [conversationId, beforeMessageId, maxTurns * 10],
  );
  rows.reverse(); // oldest first
  const turns: HistoryTurn[] = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const [q, a] = [rows[i], rows[i + 1]];
    if (q.role === "user" && a.role === "assistant" && a.status === "done" && a.content.trim()) {
      const answer = a.content.length > maxAnswerChars ? a.content.slice(0, maxAnswerChars) + "…" : a.content;
      turns.push({ question: q.content, answer });
      i++; // the pair is used; continue after the answer
    }
  }
  return turns.slice(-maxTurns);
}

// Deletes a conversation and (ON DELETE CASCADE) all its messages. Refused
// with 409 while an answer is being written: finishTurn would then fail to
// save into a conversation that no longer exists. Same 5-minute rule as
// startTurn, so a conversation left busy by a crash can still be deleted.
export async function deleteConversation(id: number): Promise<void> {
  const { rowCount } = await pool.query(
    `DELETE FROM conversations
      WHERE id = $1 AND (answering_since IS NULL OR answering_since < now() - $2::interval)`,
    [id, BUSY_TIMEOUT],
  );
  if (rowCount) return;
  const exists = await pool.query("SELECT 1 FROM conversations WHERE id = $1", [id]);
  throw exists.rowCount
    ? httpError(409, "An answer in this conversation is still being written. Stop it first.")
    : httpError(404, `No conversation ${id}`);
}

export interface ConversationSummary {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

// Most recently used first. 50 is plenty for a sidebar; paging can come later.
export async function listConversations(limit = 50): Promise<ConversationSummary[]> {
  const { rows } = await pool.query<ConversationSummary>(
    `SELECT c.id, c.title, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS "messageCount"
       FROM conversations c
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export interface StoredMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  status: "done" | "stopped" | "error";
  error: string | null;
  sources: SearchResult[] | null;
  documentIds: number[] | null;
  cached: boolean;
  searchQuery: string | null;
  createdAt: string;
}

// One conversation with all its messages in order, or null if it doesn't exist.
export async function getConversation(id: number) {
  const { rows } = await pool.query<{ id: number; title: string; createdAt: string; updatedAt: string }>(
    `SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt" FROM conversations WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const messages = await pool.query<StoredMessage>(
    `SELECT id, role, content, status, error, sources, document_ids AS "documentIds", cached,
            search_query AS "searchQuery", created_at AS "createdAt"
       FROM messages WHERE conversation_id = $1 ORDER BY id`,
    [id],
  );
  return { ...rows[0], messages: messages.rows };
}
