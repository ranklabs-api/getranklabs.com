// POST /api/chat/start — open a conversation with its first message.
//
// Deliberately NOT called when the bubble is merely opened. A row exists only
// once a visitor has actually said something, so the table never fills with
// empty conversations from idle clicks and every row is a real lead.
import { readAttribution } from "../_shared/attribution.js";
import {
  CUSTOMER_ID,
  MAX_BODY,
  MAX_CONVERSATIONS_PER_IP_PER_HOUR,
  clean,
  json,
  newCode,
  randomHex,
  relayVisitorMessage,
  sha256Hex,
  sweepExpired,
} from "../_shared/chat.js";

function pagePath(value) {
  const raw = clean(value, 300);
  if (!raw) return "/";
  const path = raw.split(/[?#]/, 1)[0];
  return path.startsWith("/") ? path.slice(0, 300) : "/";
}

function locationOf(request) {
  const cf = request.cf || {};
  return [cf.city, cf.region, cf.country].filter(Boolean).join(", ").slice(0, 120) || null;
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

  const body = clean(data?.text, MAX_BODY);
  if (!body) return json({ error: "Message is required" }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ipHash = ip
    ? await sha256Hex(`${env.CHAT_IP_SALT || env.CHAT_TELEGRAM_WEBHOOK_SECRET || "ranklabs"}:${ip}`)
    : null;

  // Rate limit before writing anything. One visitor opening nine conversations
  // in an hour is not a customer.
  if (ipHash) {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const recent = await db
      .prepare("SELECT COUNT(*) AS n FROM chat_conversations WHERE ip_hash = ?1 AND created_at > ?2")
      .bind(ipHash, since)
      .first();
    if ((recent?.n ?? 0) >= MAX_CONVERSATIONS_PER_IP_PER_HOUR) {
      return json({ error: "Too many chats started. Please email hello@getranklabs.com." }, 429);
    }
  }

  const token = randomHex(24);
  const tokenHash = await sha256Hex(token);
  const attr = readAttribution(data || {});
  const now = new Date().toISOString();
  const conversation = {
    id: crypto.randomUUID(),
    customer_id: CUSTOMER_ID,
    page_path: pagePath(data?.page_path),
    location: locationOf(request),
    attributed_channel: attr.attributed_channel,
    visitor_email: null,
    tg_topic_id: null,
  };

  // `code` is short and human-typeable, so collisions are possible by design;
  // the UNIQUE index is the arbiter and we simply draw again.
  let code = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = newCode();
    try {
      await db
        .prepare(
          `INSERT INTO chat_conversations
             (id, code, customer_id, token_hash, status, created_at, last_activity_at,
              page_path, location, user_agent, ip_hash,
              referrer_host, landing_page, utm_source, utm_medium, utm_campaign, gclid,
              attributed_channel, message_count)
           VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0)`
        )
        .bind(
          conversation.id,
          candidate,
          CUSTOMER_ID,
          tokenHash,
          now,
          conversation.page_path,
          conversation.location,
          clean(request.headers.get("User-Agent") || "", 300) || null,
          ipHash,
          attr.referrer_host,
          attr.landing_page,
          attr.utm_source,
          attr.utm_medium,
          attr.utm_campaign,
          attr.gclid,
          attr.attributed_channel
        )
        .run();
      code = candidate;
      break;
    } catch (e) {
      if (!/UNIQUE/i.test(e.message || "")) {
        console.error("chat: conversation insert failed:", e.message);
        return json({ error: "Unable to start the chat. Please email hello@getranklabs.com." }, 500);
      }
    }
  }
  if (!code) {
    console.error("chat: could not allocate a conversation code after 6 attempts");
    return json({ error: "Unable to start the chat. Please email hello@getranklabs.com." }, 500);
  }

  conversation.code = code;
  const stored = await relayVisitorMessage(env, db, conversation, body, { first: true });

  // Close out abandoned conversations while we are here. Lazy expiry alone
  // never reaches rows nobody touches again, so without this the table keeps
  // rows that read as open purely because the visitor walked away. Deliberately
  // after the relay and behind waitUntil: housekeeping must not add latency to
  // a visitor waiting on their first message.
  const sweep = sweepExpired(db, CUSTOMER_ID).catch((e) =>
    console.error("chat: expiry sweep failed:", e.message)
  );
  if (typeof context.waitUntil === "function") context.waitUntil(sweep);

  return json({
    id: conversation.id,
    token,
    code,
    seq: stored.seq,
    createdAt: stored.createdAt,
  });
}
