// Site chat relay — shared helpers.
//
// The visitor types in a widget on getranklabs.com; the message is stored in D1
// and pushed to Telegram. The operator answers in Telegram; the answer comes
// back through the webhook into D1, and the widget polls it up. Telegram is a
// transport here, not the system of record — D1 is, so a conversation survives
// a dropped webhook and stays reportable alongside the other lead sources.
//
// WHY NOT WHATSAPP: the Cloud API requires the number to be removed from the
// WhatsApp app, and as of 2026-10-01 Meta bills service messages past 1,000/mo
// and stops delivering them entirely without a payment method on file. The
// visitor is not a WhatsApp user either, so the API would only ever be
// notifying us. Telegram's Bot API does the same job with no number migration
// and no billing relationship. A wa.me click-to-chat link is offered in the
// widget for visitors who prefer WhatsApp — that path needs no API at all.

export const CUSTOMER_ID = "getranklabs";

// Abuse limits. These are deliberately low: this is a two-person agency's
// inbox, not a support desk, and every message costs a Telegram push.
export const MAX_BODY = 2000;
export const MAX_MESSAGES_PER_CONVERSATION = 100;
export const MAX_CONVERSATIONS_PER_IP_PER_HOUR = 8;
export const MIN_MS_BETWEEN_VISITOR_MESSAGES = 700;

// Unambiguous alphabet — no 0/O/1/I. The code is read aloud off a phone screen
// and typed back as `/r <code>`, so confusable glyphs are a real cost.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // The widget is same-origin, so no CORS grant is needed or wanted.
      "Cache-Control": "no-store",
    },
  });
}

export function clean(value, max = MAX_BODY) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function randomHex(bytes = 24) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newCode() {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

// Length-independent comparison. Both inputs here are fixed-length hex digests,
// but the helper is written not to leak length either, so it stays correct if it
// is ever reused on a raw secret.
export function timingSafeEqual(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    diff |= x.charCodeAt(i % (x.length || 1)) ^ y.charCodeAt(i % (y.length || 1));
  }
  return diff === 0;
}

// Telegram's HTML parse mode. Only these three need escaping, and all three
// must be escaped in text nodes AND attribute values.
export function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Telegram ───────────────────────────────────────────────────────────────

export async function telegram(env, method, payload) {
  const token = env.CHAT_TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("CHAT_TELEGRAM_BOT_TOKEN is not configured");
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok !== true) {
    throw new Error(`telegram ${method} failed (${resp.status}): ${data.description || "unknown"}`);
  }
  return data.result;
}

// Where operator notifications go. A forum supergroup gives every visitor its
// own real thread in the Telegram UI; a DM gives one linear chat where replies
// are matched by quote. Forum mode is opt-in because it needs a group that the
// bot administers.
export function notifyTarget(env) {
  const forum = clean(env.TELEGRAM_FORUM_CHAT_ID, 64);
  if (forum) return { chatId: forum, forum: true };
  return { chatId: clean(env.TELEGRAM_CHAT_ID, 64), forum: false };
}

// Opens the per-visitor forum topic, or returns null to fall back to DM-style
// quoting. Never throws: a misconfigured group must degrade to a working
// linear chat rather than drop a live customer's first message.
export async function ensureTopic(env, conversation, headline) {
  const target = notifyTarget(env);
  if (!target.forum) return null;
  if (conversation.tg_topic_id) return conversation.tg_topic_id;
  try {
    const topic = await telegram(env, "createForumTopic", {
      chat_id: target.chatId,
      name: `${conversation.code} · ${headline}`.slice(0, 128),
    });
    return topic?.message_thread_id ?? null;
  } catch (e) {
    console.error("chat: createForumTopic failed, falling back to DM threading:", e.message);
    return null;
  }
}

// ── D1 ─────────────────────────────────────────────────────────────────────

export async function loadConversation(db, id, token) {
  const row = await db
    .prepare("SELECT * FROM chat_conversations WHERE id = ?1 AND customer_id = ?2")
    .bind(id, CUSTOMER_ID)
    .first();
  if (!row) return null;
  const hash = await sha256Hex(token);
  // Unauthorised and not-found are deliberately indistinguishable to the
  // caller, so a conversation id cannot be confirmed without its token.
  if (!timingSafeEqual(hash, row.token_hash)) return null;
  return row;
}

export async function appendMessage(db, { conversationId, sender, body, tgMessageId = null }) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const row = await db
    .prepare(
      `INSERT INTO chat_messages (id, conversation_id, sender, body, created_at, tg_message_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING seq`
    )
    .bind(id, conversationId, sender, body, createdAt, tgMessageId)
    .first();
  await db
    .prepare(
      `UPDATE chat_conversations
          SET message_count = message_count + 1, last_activity_at = ?2
        WHERE id = ?1`
    )
    .bind(conversationId, createdAt)
    .run();
  return { id, seq: row?.seq ?? null, createdAt };
}

// Push one visitor message to the operator and record which Telegram message
// carried it, which is what makes a Telegram reply resolvable back to this
// conversation in DM mode.
//
// The D1 write happens FIRST and the Telegram id is patched in after. A failed
// push must still leave the message stored and pollable — losing a customer's
// words because a notification 500'd would be the worst possible failure here.
export async function relayVisitorMessage(env, db, conversation, body, { first = false } = {}) {
  const stored = await appendMessage(db, {
    conversationId: conversation.id,
    sender: "visitor",
    body,
  });

  try {
    const target = notifyTarget(env);
    if (!target.chatId) throw new Error("no Telegram chat id configured");

    let topicId = conversation.tg_topic_id ?? null;
    if (first) {
      topicId = await ensureTopic(env, conversation, body.replace(/\s+/g, " ").slice(0, 60));
      if (topicId) {
        await db
          .prepare("UPDATE chat_conversations SET tg_topic_id = ?2 WHERE id = ?1")
          .bind(conversation.id, topicId)
          .run();
      }
    }

    const meta = [
      conversation.page_path,
      conversation.location,
      conversation.attributed_channel,
      conversation.visitor_email,
    ].filter(Boolean).join(" · ");

    const header = first
      ? `💬 <b>New chat</b> · <code>${escapeHtml(conversation.code)}</code>`
      : `💬 <code>${escapeHtml(conversation.code)}</code>`;
    const lines = [header];
    if (first && meta) lines.push(`<i>${escapeHtml(meta)}</i>`);
    lines.push("", escapeHtml(body));
    if (first) lines.push("", "<i>Reply to this message to answer the visitor.</i>");

    const sent = await telegram(env, "sendMessage", {
      chat_id: target.chatId,
      ...(topicId ? { message_thread_id: topicId } : {}),
      text: lines.join("\n"),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });

    if (sent?.message_id) {
      await db
        .prepare("UPDATE chat_messages SET tg_message_id = ?2 WHERE id = ?1")
        .bind(stored.id, sent.message_id)
        .run();
    }
  } catch (e) {
    // Surfaced in `wrangler pages deployment tail`. The visitor still gets a
    // success response because their message is safely stored.
    console.error("chat: operator notification failed:", e.message);
  }

  return stored;
}
