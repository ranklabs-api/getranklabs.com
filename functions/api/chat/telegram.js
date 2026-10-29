// POST /api/chat/telegram — Telegram webhook. The operator's answers come in
// here and become visitor-visible messages.
//
// IMPORTANT: this webhook belongs to a DEDICATED bot (@Getranklabs_bot), not to
// @tg_easybot. The Hermes gateway long-polls getUpdates on that other bot, and
// Telegram permits a webhook OR getUpdates per bot, never both — pointing this
// at tg_easybot would silently cut the gateway's control channel.
//
// How a reply is matched back to a conversation, in order:
//   1. forum mode — message_thread_id is the per-visitor topic
//   2. DM mode    — a native reply quotes the bot message that carried the
//                   visitor's words, and we stored that message_id
//   3. either     — an explicit `/r <CODE> <text>`, for answering from a
//                   notification that has scrolled away
import {
  appendMessage,
  clean,
  escapeHtml,
  json,
  notifyTarget,
  telegram,
  timingSafeEqual,
} from "../_shared/chat.js";

const HELP = [
  "<b>Rank Labs site chat</b>",
  "",
  "Reply to a message to answer that visitor.",
  "<code>/r CODE your answer</code> — answer by conversation code",
  "<code>/close CODE</code> — close a conversation",
].join("\n");

async function ack(env, chatId, threadId, text) {
  try {
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: threadId } : {}),
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    console.error("chat: webhook ack failed:", e.message);
  }
}

async function findByCode(db, code) {
  return db
    .prepare("SELECT * FROM chat_conversations WHERE code = ?1")
    .bind(code.toUpperCase())
    .first();
}

export async function onRequestPost(context) {
  const { env, request } = context;

  // Telegram sends the configured secret in this header on every delivery.
  // Anything else is not Telegram and never reaches the database.
  const secret = clean(env.CHAT_TELEGRAM_WEBHOOK_SECRET, 256);
  const presented = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!secret || !timingSafeEqual(secret, presented)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const db = env.PERFORMANCE_DB;
  if (!db) return json({ ok: true });

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: true });
  }

  const message = update?.message || update?.edited_message;
  const text = clean(message?.text, 4000);
  // Service messages (topic created, members joining) carry no text.
  if (!message || !text) return json({ ok: true });

  // Only the configured DM or the configured forum group may drive this.
  const target = notifyTarget(env);
  const allowed = [clean(env.TELEGRAM_CHAT_ID, 64), clean(env.TELEGRAM_FORUM_CHAT_ID, 64)].filter(Boolean);
  if (!allowed.includes(String(message.chat?.id))) {
    console.error("chat: webhook update from unexpected chat", message.chat?.id);
    return json({ ok: true });
  }

  const chatId = String(message.chat.id);
  const threadId = message.message_thread_id ?? null;

  if (/^\/(help|start)\b/.test(text)) {
    await ack(env, chatId, threadId, HELP);
    return json({ ok: true });
  }

  // /close CODE
  const closeMatch = text.match(/^\/close\s+([A-Za-z0-9]{4})\s*$/);
  if (closeMatch) {
    const conversation = await findByCode(db, closeMatch[1]);
    if (!conversation) {
      await ack(env, chatId, threadId, `No conversation <code>${escapeHtml(closeMatch[1])}</code>.`);
      return json({ ok: true });
    }
    await db.prepare("UPDATE chat_conversations SET status = 'closed' WHERE id = ?1").bind(conversation.id).run();
    await ack(env, chatId, threadId, `Closed <code>${escapeHtml(conversation.code)}</code>.`);
    return json({ ok: true });
  }

  let conversation = null;
  let body = text;

  // 3. explicit code
  const codeMatch = text.match(/^\/r\s+([A-Za-z0-9]{4})\s+([\s\S]+)$/);
  if (codeMatch) {
    conversation = await findByCode(db, codeMatch[1]);
    body = clean(codeMatch[2], 4000);
    if (!conversation) {
      await ack(env, chatId, threadId, `No conversation <code>${escapeHtml(codeMatch[1])}</code>.`);
      return json({ ok: true });
    }
  }

  // 1. forum topic
  if (!conversation && threadId && target.forum) {
    conversation = await db
      .prepare("SELECT * FROM chat_conversations WHERE tg_topic_id = ?1")
      .bind(threadId)
      .first();
  }

  // 2. native reply
  if (!conversation && message.reply_to_message?.message_id) {
    const row = await db
      .prepare(
        `SELECT c.* FROM chat_messages m
           JOIN chat_conversations c ON c.id = m.conversation_id
          WHERE m.tg_message_id = ?1
          LIMIT 1`
      )
      .bind(message.reply_to_message.message_id)
      .first();
    if (row) conversation = row;
  }

  if (!conversation) {
    // Silence here would look exactly like a delivered answer, so say so.
    await ack(
      env,
      chatId,
      threadId,
      "Not sure which visitor that was for. Reply <i>to</i> one of the chat messages, or use <code>/r CODE your answer</code>."
    );
    return json({ ok: true });
  }

  if (!body) return json({ ok: true });

  if (conversation.status === "closed") {
    await ack(env, chatId, threadId, `<code>${escapeHtml(conversation.code)}</code> is closed — not delivered.`);
    return json({ ok: true });
  }

  await appendMessage(db, {
    conversationId: conversation.id,
    sender: "agent",
    body,
    tgMessageId: message.message_id,
  });

  return json({ ok: true });
}
