-- Site chat relay — schema for the D1 database bound as PERFORMANCE_DB
-- (Cloudflare D1 `ranklabs-leads`).
--
-- Applied with:
--   wrangler d1 execute ranklabs-leads --remote --file=db/chat-schema.sql
--
-- customer_id is carried on every row even though this site only ever writes
-- 'getranklabs'. The other three customer sites share this database and the
-- same Pages Function pattern, so the tables are built to take them without a
-- migration. Every read filters on it.

CREATE TABLE IF NOT EXISTS chat_conversations (
  id               TEXT PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  customer_id      TEXT NOT NULL,
  -- SHA-256 of the visitor's bearer token. The token itself is returned once,
  -- at /api/chat/start, and never stored: a D1 leak must not grant the ability
  -- to read or post into other people's conversations.
  token_hash       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  created_at       TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  visitor_name     TEXT,
  visitor_email    TEXT,
  page_path        TEXT,
  -- Human-readable "City, Region, CC" from Cloudflare request.cf, for context in
  -- the Telegram notification. Never the IP.
  location         TEXT,
  user_agent       TEXT,
  -- Salted hash, never the address itself. Only used to rate-limit conversation
  -- creation, so it never needs to be reversible.
  ip_hash          TEXT,
  referrer_host    TEXT,
  landing_page     TEXT,
  utm_source       TEXT,
  utm_medium       TEXT,
  utm_campaign     TEXT,
  gclid            TEXT,
  attributed_channel TEXT,
  -- Forum-topic id when TELEGRAM_FORUM_CHAT_ID is configured; NULL in DM mode.
  tg_topic_id      INTEGER,
  message_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chat_conv_customer  ON chat_conversations(customer_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_conv_ip        ON chat_conversations(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_conv_topic     ON chat_conversations(tg_topic_id);

-- seq is a single global AUTOINCREMENT rather than a per-conversation counter.
-- The widget polls with `?after=<seq>`, and a global monotonic key makes that a
-- plain indexed range scan with no counter row to race on.
CREATE TABLE IF NOT EXISTS chat_messages (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  sender          TEXT NOT NULL CHECK (sender IN ('visitor', 'agent', 'system')),
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  -- id of the Telegram message that carried this to the operator. In DM mode
  -- this is the reply-mapping key: a Telegram reply quotes one of these.
  tg_message_id   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chat_msg_conv ON chat_messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_chat_msg_tg   ON chat_messages(tg_message_id);
