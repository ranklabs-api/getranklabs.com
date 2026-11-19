// POST /api/chat/email — the away path.
//
// When nobody answers within the widget's grace period it asks for an email so
// the lead is not lost to a closed tab. That makes it a real lead, so it is
// recorded in performance_events as generate_lead with form_id 'chat', exactly
// like the contact form, and mailed through the same Resend sender.
import { readAttribution, ATTRIBUTION_COLUMNS } from "../_shared/attribution.js";
import { appendMessage, clean, escapeHtml, json, loadConversation, notifyTarget, telegram } from "../_shared/chat.js";

const FROM = "Rank Labs <hello@getranklabs.com>";
const TO = "josiah@getranklabs.com";

// Intentionally permissive: rejecting a real address costs a customer, while a
// junk one costs one email. Length is capped to the RFC maximum.
function validEmail(value) {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value) && value.length <= 320;
}

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

  const email = clean(data?.email, 320).toLowerCase();
  const name = clean(data?.name, 200);
  if (!validEmail(email)) return json({ error: "Please enter a valid email address." }, 400);

  const conversation = await loadConversation(db, clean(data?.id, 64), clean(data?.token, 128));
  if (!conversation) return json({ error: "Conversation not found" }, 404);

  await db
    .prepare("UPDATE chat_conversations SET visitor_email = ?2, visitor_name = ?3 WHERE id = ?1")
    .bind(conversation.id, email, name || null)
    .run();

  await appendMessage(db, {
    conversationId: conversation.id,
    sender: "system",
    body: `Visitor left contact details: ${name ? `${name}, ` : ""}${email}`,
  });

  // Transcript so far — the email is useless without the question that prompted it.
  const { results } = await db
    .prepare("SELECT sender, body FROM chat_messages WHERE conversation_id = ?1 ORDER BY seq LIMIT 100")
    .bind(conversation.id)
    .all();
  const transcript = (results || [])
    .filter((row) => row.sender !== "system")
    .map((row) => `${row.sender === "agent" ? "Josiah" : "Visitor"}: ${row.body}`)
    .join("\n");

  const target = notifyTarget(env);
  if (target.chatId) {
    try {
      await telegram(env, "sendMessage", {
        chat_id: target.chatId,
        ...(conversation.tg_topic_id ? { message_thread_id: conversation.tg_topic_id } : {}),
        text: [
          `📧 <b>Contact details</b> · <code>${escapeHtml(conversation.code)}</code>`,
          "",
          escapeHtml(`${name ? `${name} — ` : ""}${email}`),
        ].join("\n"),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      console.error("chat: email-capture Telegram push failed:", e.message);
    }
  }

  // Email + analytics are both best-effort: the details are already saved, so
  // neither failure should tell the visitor their submission did not land.
  try {
    if (env.RESEND_API_KEY) {
      const rows = [
        ["Conversation", conversation.code],
        ["Name", name || "(not given)"],
        ["Email", email],
        ["Page", conversation.page_path || "/"],
        ["Location", conversation.location || "(unknown)"],
        ["Channel", conversation.attributed_channel || "(not captured)"],
      ];
      const table = rows
        .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#9aa4b2"><strong>${escapeHtml(k)}</strong></td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`)
        .join("");
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM,
          to: TO,
          reply_to: email,
          subject: `Site chat lead: ${name || email} (${conversation.code})`,
          html: `<div style="font-family:-apple-system,sans-serif;background:#0f1117;color:#e1e4e8;padding:24px;border-radius:12px"><h2 style="color:#7c3aed">Site chat — visitor left contact details</h2><table>${table}</table><p><strong>Transcript:</strong></p><p style="background:#161b22;padding:12px;border-radius:8px;white-space:pre-wrap">${escapeHtml(transcript)}</p></div>`,
          text: [`Site chat lead`, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", "Transcript:", transcript].join("\n"),
        }),
      });
    }
  } catch (e) {
    console.error("chat: lead email failed:", e.message);
  }

  try {
    const receivedAt = new Date().toISOString();
    const attr = readAttribution(data || {});
    const event = db
      .prepare(
        `INSERT INTO performance_events
           (id, customer_id, event_name, occurred_at, received_at, form_id, form_type, page_path, event_version,
            referrer_url, referrer_host, landing_page, utm_source, utm_medium, utm_campaign, gclid,
            ga_client_id, attributed_channel)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        conversation.customer_id,
        "generate_lead",
        receivedAt,
        receivedAt,
        "chat",
        "chat",
        conversation.page_path || "/",
        1,
        ...ATTRIBUTION_COLUMNS.map((c) => attr[c])
      )
      .run()
      .catch((error) => console.error("chat: performance event logging failed:", error.message));
    if (typeof context.waitUntil === "function") context.waitUntil(event);
  } catch (e) {
    console.error("chat: performance event logging failed:", e.message);
  }

  return json({ ok: true });
}
