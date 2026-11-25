// Per-UTC-day rate limits (functions/api/_shared/instant-check/limits.js).

import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeD1, row } from "./helpers/fake-d1.mjs";
import { loadInstantCheck } from "./helpers/load.mjs";

const { LIMITS, consume, hashIdentifier, ipBucket, emailBucket, domainBucket } = await loadInstantCheck("limits.js");

const SALT = "test-secret-salt-0123456789";

test("limits are 3 per IP, 2 per email, 1 per domain", () => {
  assert.deepEqual(LIMITS, { ip: 3, email: 2, domain: 1 });
});

for (const [kind, limit] of Object.entries({ ip: 3, email: 2, domain: 1 })) {
  test(`${kind}: ${limit} allowed, then denied, and the next UTC day resets`, async () => {
    const fake = createFakeD1();
    const bucket = `${kind}:abc`;
    for (let i = 1; i <= limit; i++) {
      assert.deepEqual(await consume(fake.db, { bucket, day: "2026-11-25", limit }), { ok: true, n: i });
    }
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await consume(fake.db, { bucket, day: "2026-11-25", limit }), { ok: false, reason: "limited" });
    }
    assert.equal(row(fake, "SELECT n FROM instant_check_rate WHERE bucket = ? AND day = ?", bucket, "2026-11-25").n, limit);
    assert.deepEqual(await consume(fake.db, { bucket, day: "2026-11-26", limit }), { ok: true, n: 1 });
  });
}

test("buckets are independent", async () => {
  const fake = createFakeD1();
  assert.equal((await consume(fake.db, { bucket: "domain:a.com", day: "2026-11-25", limit: 1 })).ok, true);
  assert.equal((await consume(fake.db, { bucket: "domain:b.com", day: "2026-11-25", limit: 1 })).ok, true);
  assert.equal((await consume(fake.db, { bucket: "domain:a.com", day: "2026-11-25", limit: 1 })).ok, false);
});

test("a limiter error counts as limited (fail closed)", async () => {
  const fake = createFakeD1();
  fake.failWhen = () => true;
  assert.deepEqual(await consume(fake.db, { bucket: "ip:x", day: "2026-11-25", limit: 3 }), { ok: false, reason: "error" });
});

test("bad arguments count as limited without touching D1", async () => {
  const fake = createFakeD1();
  for (const args of [{}, { bucket: "", day: "2026-11-25", limit: 1 }, { bucket: "ip:x", day: "2026-11-25", limit: 0 }, { bucket: "ip:x", limit: 1 }]) {
    assert.equal((await consume(fake.db, args)).ok, false);
  }
  assert.equal(fake.calls.length, 0);
});

test("hashIdentifier is SHA-256 hex of salt:value", async () => {
  const hash = await hashIdentifier(SALT, "203.0.113.7");
  assert.match(hash, /^[0-9a-f]{64}$/);
  const expected = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${SALT}:203.0.113.7`))).toString("hex");
  assert.equal(hash, expected);
  assert.notEqual(await hashIdentifier(`${SALT}x`, "203.0.113.7"), hash);
});

test("hashIdentifier requires a salt of at least 16 characters", async () => {
  for (const salt of [undefined, null, "", "short", "fifteen-chars!!", 1234567890123456789]) {
    await assert.rejects(() => hashIdentifier(salt, "203.0.113.7"), /salt/, String(salt));
  }
  await assert.doesNotReject(() => hashIdentifier("sixteen-chars!!!", "x"));
});

test("bucket names", () => {
  assert.equal(ipBucket("ab12"), "ip:ab12");
  assert.equal(emailBucket("cd34"), "email:cd34");
  assert.equal(domainBucket("example.com"), "domain:example.com");
});
