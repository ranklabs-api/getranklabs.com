// 24h result cache and request/ledger writes
// (functions/api/_shared/instant-check/cache.js, requests.js).

import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeD1, row, rows } from "./helpers/fake-d1.mjs";
import { loadInstantCheck } from "./helpers/load.mjs";

const { CACHE_TTL_MS, PROMPT_VERSION, getCached, putCached } = await loadInstantCheck("cache.js");
const { recordRequest, recordProbe, newId } = await loadInstantCheck("requests.js");

const NOW = Date.parse("2026-11-25T15:00:00Z");
const RESULT = { status: "completed", score: { overall_score: 61 } };

test("TTL is 24h and the prompt version is 1", () => {
  assert.equal(CACHE_TTL_MS, 86_400_000);
  assert.equal(PROMPT_VERSION, 1);
});

test("miss before put, hit after", async () => {
  const fake = createFakeD1();
  assert.equal(await getCached(fake.db, "example.com", NOW), null);
  assert.deepEqual(await putCached(fake.db, "example.com", RESULT, NOW), { ok: true });
  assert.deepEqual(await getCached(fake.db, "example.com", NOW + 1000), RESULT);
  assert.equal(await getCached(fake.db, "other.com", NOW + 1000), null);
});

test("hit just inside the TTL, miss at and after expiry", async () => {
  const fake = createFakeD1();
  await putCached(fake.db, "example.com", RESULT, NOW);
  assert.deepEqual(await getCached(fake.db, "example.com", NOW + CACHE_TTL_MS - 1), RESULT);
  assert.equal(await getCached(fake.db, "example.com", NOW + CACHE_TTL_MS), null);
  assert.equal(await getCached(fake.db, "example.com", NOW + 2 * CACHE_TTL_MS), null);
});

test("a re-put refreshes the entry", async () => {
  const fake = createFakeD1();
  await putCached(fake.db, "example.com", RESULT, NOW);
  await putCached(fake.db, "example.com", { ...RESULT, v: 2 }, NOW + CACHE_TTL_MS);
  assert.deepEqual(await getCached(fake.db, "example.com", NOW + CACHE_TTL_MS + 1), { ...RESULT, v: 2 });
  assert.equal(rows(fake, "SELECT * FROM instant_check_cache").length, 1);
});

test("a row from another prompt version is a miss", async () => {
  const fake = createFakeD1();
  fake.sqlite
    .prepare("INSERT INTO instant_check_cache VALUES (?, ?, ?, ?, ?)")
    .run("example.com", PROMPT_VERSION + 1, JSON.stringify(RESULT), "2026-11-25T00:00:00.000Z", "2099-01-01T00:00:00.000Z");
  assert.equal(await getCached(fake.db, "example.com", NOW), null);
});

test("a D1 error or corrupt JSON is a miss", async () => {
  const fake = createFakeD1();
  await putCached(fake.db, "example.com", RESULT, NOW);
  fake.failWhen = () => true;
  assert.equal(await getCached(fake.db, "example.com", NOW), null);
  fake.failWhen = null;
  fake.sqlite.exec("UPDATE instant_check_cache SET result_json = '{not json'");
  assert.equal(await getCached(fake.db, "example.com", NOW), null);
});

test("putCached returns a D1 error", async () => {
  const fake = createFakeD1();
  fake.failWhen = () => true;
  const r = await putCached(fake.db, "example.com", RESULT, NOW);
  assert.equal(r.ok, false);
  assert.ok(r.error instanceof Error);
});

test("recordRequest inserts a request row", async () => {
  const fake = createFakeD1();
  const id = newId();
  const r = await recordRequest(fake.db, {
    id, created_at: "2026-11-25T15:00:00.000Z", domain: "example.com", email: "owner@example.com",
    business_name: "Example Plumbing", service: "plumber", city: "Kansas City", ip_hash: "ab".repeat(32),
    status: "queued_manual", queue_reason: "kill_switch", result_json: { score: 1 },
  });
  assert.deepEqual(r, { ok: true });
  const saved = row(fake, "SELECT * FROM instant_check_requests WHERE id = ?", id);
  assert.equal(saved.status, "queued_manual");
  assert.equal(saved.queue_reason, "kill_switch");
  assert.equal(saved.result_json, '{"score":1}');
  assert.equal(saved.followed_up_at, null);
});

test("recordRequest returns the error for a status the schema refuses", async () => {
  const fake = createFakeD1();
  const r = await recordRequest(fake.db, {
    id: newId(), created_at: "2026-11-25T15:00:00.000Z", domain: "example.com", email: "a@b.co", status: "bogus",
  });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /CHECK/);
});

test("recordProbe inserts a ledger row and returns D1 errors", async () => {
  const fake = createFakeD1();
  const id = newId();
  assert.deepEqual(await recordProbe(fake.db, {
    id, request_id: "req-1", day: "2026-11-25", engine: "perplexity-sonar", model: "perplexity/sonar",
    reserved_micros: 10_000, actual_micros: 4_100, status: "succeeded", created_at: "2026-11-25T15:00:00.000Z",
  }), { ok: true });
  assert.equal(row(fake, "SELECT actual_micros FROM instant_check_probe_ledger WHERE id = ?", id).actual_micros, 4_100);
  fake.failWhen = () => true;
  assert.equal((await recordProbe(fake.db, { id: newId() })).ok, false);
});
