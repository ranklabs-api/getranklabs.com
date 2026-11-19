// GET /api/chat/poll?id=&token=&after=<seq> — messages newer than `after`.
//
// Polling rather than a WebSocket/Durable Object on purpose: this is an agency
// site's traffic, the free-plan request budget is nowhere near binding, and a
// plain indexed range scan is far easier to reason about than hibernation
// semantics when something looks wrong at 7am.
import { clean, expireIfIdle, json, loadConversation } from "../_shared/chat.js";

export async function onRequestGet(context) {
  const { env, request } = context;
  const db = env.PERFORMANCE_DB;
  if (!db) return json({ error: "Chat is unavailable right now." }, 503);

  const url = new URL(request.url);
  const loaded = await loadConversation(
    db,
    clean(url.searchParams.get("id"), 64),
    clean(url.searchParams.get("token"), 128)
  );
  if (!loaded) return json({ error: "Conversation not found" }, 404);

  // Evaluated on read, so a widget left open overnight is told to stop rather
  // than polling a dead conversation until the tab closes.
  const conversation = await expireIfIdle(db, loaded);

  const afterRaw = Number.parseInt(url.searchParams.get("after") || "0", 10);
  const after = Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : 0;

  const { results } = await db
    .prepare(
      `SELECT seq, sender, body, created_at
         FROM chat_messages
        WHERE conversation_id = ?1 AND seq > ?2
        ORDER BY seq
        LIMIT 100`
    )
    .bind(conversation.id, after)
    .all();

  return json({
    status: conversation.status,
    messages: (results || []).map((row) => ({
      seq: row.seq,
      sender: row.sender,
      body: row.body,
      createdAt: row.created_at,
    })),
  });
}
