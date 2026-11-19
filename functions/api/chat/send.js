// POST /api/chat/send — a follow-up message from the visitor.
import {
  MAX_BODY,
  MAX_MESSAGES_PER_CONVERSATION,
  MIN_MS_BETWEEN_VISITOR_MESSAGES,
  clean,
  expireIfIdle,
  json,
  loadConversation,
  relayVisitorMessage,
} from "../_shared/chat.js";

export async function onRequestPost(context) {
  const { env, request } = context;
  const db = env.PERFORMANCE_DB;
  if (!db) return json({ error: "Chat is unavailable right now." }, 503);

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const body = clean(data?.text, MAX_BODY);
  if (!body) return json({ error: "Message is required" }, 400);

  const loaded = await loadConversation(db, clean(data?.id, 64), clean(data?.token, 128));
  if (!loaded) return json({ error: "Conversation not found" }, 404);

  const conversation = await expireIfIdle(db, loaded);
  // 410 Gone, not 409: a timeout is recoverable and the widget answers it by
  // transparently opening a new conversation with the same text, so the visitor
  // never sees a failure. An explicit close is a decision and stays a 409.
  if (conversation.status === "expired") {
    return json({ error: "This chat timed out.", expired: true }, 410);
  }
  if (conversation.status === "closed") return json({ error: "This chat has been closed." }, 409);

  if (conversation.message_count >= MAX_MESSAGES_PER_CONVERSATION) {
    return json({ error: "This chat has reached its message limit. Please email hello@getranklabs.com." }, 429);
  }

  // Cheap flood guard: one message per 700ms per conversation. Enough to stop a
  // script in a loop without ever being noticeable to a person typing.
  const last = Date.parse(conversation.last_activity_at || "");
  if (Number.isFinite(last) && Date.now() - last < MIN_MS_BETWEEN_VISITOR_MESSAGES) {
    return json({ error: "Slow down a moment." }, 429);
  }

  const stored = await relayVisitorMessage(env, db, conversation, body);
  return json({ seq: stored.seq, createdAt: stored.createdAt });
}
