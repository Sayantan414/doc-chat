// GET /api/conversations      the newest 50 conversations (id, title, dates, message count)
// GET /api/conversations/:id  one conversation with all its messages, in order
//
// No auth yet: anyone who can reach the API can read every conversation.

import { Router } from "express";
import { getConversation, listConversations } from "../history/conversations.js";
import { httpError } from "./httpError.js";

export const conversationsRouter = Router();

conversationsRouter.get("/conversations", async (_req, res) => {
  res.json(await listConversations());
});

conversationsRouter.get("/conversations/:id", async (req, res) => {
  // Only a plain positive whole number that fits an INTEGER column.
  if (!/^\d{1,10}$/.test(req.params.id) || Number(req.params.id) > 2_147_483_647 || Number(req.params.id) === 0) {
    throw httpError(400, "Conversation id must be a positive whole number");
  }
  const conversation = await getConversation(Number(req.params.id));
  if (!conversation) throw httpError(404, `No conversation ${req.params.id}`);
  res.json(conversation);
});
