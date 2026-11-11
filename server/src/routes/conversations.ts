// GET /api/conversations      the newest 50 conversations (id, title, dates, message count)
// GET /api/conversations/:id  one conversation with all its messages, in order
// DELETE /api/conversations/:id  the conversation and its messages (204), 409 while answering
//
// No auth yet: anyone who can reach the API can read every conversation.

import { Router } from "express";
import { deleteConversation, getConversation, listConversations } from "../history/conversations.js";
import { httpError } from "./httpError.js";

export const conversationsRouter = Router();

conversationsRouter.get("/conversations", async (_req, res) => {
  res.json(await listConversations());
});

// Only a plain positive whole number that fits an INTEGER column.
function parseId(raw: string): number {
  if (!/^\d{1,10}$/.test(raw) || Number(raw) > 2_147_483_647 || Number(raw) === 0) {
    throw httpError(400, "Conversation id must be a positive whole number");
  }
  return Number(raw);
}

conversationsRouter.get("/conversations/:id", async (req, res) => {
  const conversation = await getConversation(parseId(req.params.id));
  if (!conversation) throw httpError(404, `No conversation ${req.params.id}`);
  res.json(conversation);
});

conversationsRouter.delete("/conversations/:id", async (req, res) => {
  await deleteConversation(parseId(req.params.id));
  res.status(204).end(); // done, nothing to send back
});
