-- Instant Free AI Visibility Check — initial schema for the D1 database bound
-- as PERFORMANCE_DB (Cloudflare D1 `ranklabs-leads`).
--
-- STATUS: UNAPPLIED. This file is checked in so the schema can be reviewed and
-- tested (tests/instant-check/helpers/fake-d1.mjs loads this exact file). It has
-- NOT been run against any D1 database. Applying it needs Josiah's GO. When
-- approved, it would be applied with:
--
--   wrangler d1 execute ranklabs-leads --remote --file=db/migrations/instant_check_0001_init.sql
--
-- Every statement is idempotent (IF NOT EXISTS / INSERT OR IGNORE), so a
-- re-run is harmless.
--
-- Money is integer micro-dollars (1 USD = 1,000,000 micros) everywhere. No
-- floats touch the budget.

-- Single-row control table. The feature ships KILLED: kill_switch = 1 means
-- OFF, and the endpoint's spend reservation can never succeed until an
-- operator sets it to 0. daily_cap_micros is bounded by CHECK to the $2.00/day
-- hard cap; budget.js also takes MIN() against its own HARD_CAP_MICROS, so a
-- tampered row cannot raise the ceiling either way.
CREATE TABLE IF NOT EXISTS instant_check_control (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  kill_switch      INTEGER NOT NULL DEFAULT 1,
  daily_cap_micros INTEGER NOT NULL DEFAULT 2000000 CHECK (daily_cap_micros BETWEEN 0 AND 2000000),
  updated_at       TEXT
);

INSERT OR IGNORE INTO instant_check_control (id, kill_switch, daily_cap_micros, updated_at)
VALUES (1, 1, 2000000, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

-- One row per UTC day. reserved_micros is the worst-case reservation taken
-- before each paid provider call, corrected by settle() once the provider's
-- usage is known.
CREATE TABLE IF NOT EXISTS instant_check_spend (
  day             TEXT PRIMARY KEY,
  reserved_micros INTEGER NOT NULL DEFAULT 0,
  paid_calls      INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT
);

-- Per-UTC-day counters. bucket is 'ip:<sha256>', 'email:<sha256>' or
-- 'domain:<bare domain>'. Raw IPs and emails are never used as keys.
CREATE TABLE IF NOT EXISTS instant_check_rate (
  bucket TEXT NOT NULL,
  day    TEXT NOT NULL,
  n      INTEGER NOT NULL,
  PRIMARY KEY (bucket, day)
);

-- 24h result cache keyed on the bare domain and the probe prompt version, so a
-- prompt change never serves results produced by the old prompt.
CREATE TABLE IF NOT EXISTS instant_check_cache (
  domain         TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  result_json    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  PRIMARY KEY (domain, prompt_version)
);

-- Every submission that passed Turnstile, whatever its outcome. queued_manual
-- rows are the follow-up list (crawl blocked, daily cap, kill switch, ...).
CREATE TABLE IF NOT EXISTS instant_check_requests (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  domain         TEXT NOT NULL,
  email          TEXT NOT NULL,
  business_name  TEXT,
  service        TEXT,
  city           TEXT,
  ip_hash        TEXT,
  status         TEXT NOT NULL CHECK (status IN ('completed', 'cached', 'queued_manual', 'rejected')),
  queue_reason   TEXT,
  result_json    TEXT,
  followed_up_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_instant_check_requests_status ON instant_check_requests(status, created_at);

-- One row per paid provider call: what was reserved and what it actually cost.
CREATE TABLE IF NOT EXISTS instant_check_probe_ledger (
  id              TEXT PRIMARY KEY,
  request_id      TEXT,
  day             TEXT NOT NULL,
  engine          TEXT NOT NULL,
  model           TEXT NOT NULL,
  reserved_micros INTEGER NOT NULL,
  actual_micros   INTEGER,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
