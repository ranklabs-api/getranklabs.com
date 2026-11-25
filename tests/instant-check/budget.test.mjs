// Daily spend cap + kill switch (functions/api/_shared/instant-check/budget.js)
// against the real migration in a node:sqlite fake D1.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeD1, row } from "./helpers/fake-d1.mjs";
import { loadInstantCheck } from "./helpers/load.mjs";

const { HARD_CAP_MICROS, reserve, settle, killSwitchActive, utcDay } = await loadInstantCheck("budget.js");

const NOW = Date.parse("2026-11-25T15:00:00Z");
const DAY = "2026-11-25";

function enabledDb() {
  const fake = createFakeD1();
  fake.sqlite.exec("UPDATE instant_check_control SET kill_switch = 0 WHERE id = 1");
  return fake;
}

// Deterministic sizes: mostly probe-sized, with occasional large requests.
function* sizes(n) {
  let seed = 42;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    yield i % 50 === 0 ? 150_000 + (seed % 100_000) : 1 + (seed % 15_000);
  }
}

test("HARD_CAP_MICROS is $2.00", () => {
  assert.equal(HARD_CAP_MICROS, 2_000_000);
});

test("utcDay is the UTC calendar day", () => {
  assert.equal(utcDay(Date.parse("2026-11-25T23:59:59Z")), "2026-11-25");
  assert.equal(utcDay(Date.parse("2026-11-26T00:00:00Z")), "2026-11-26");
});

test("500 sequential reserves of varying sizes never exceed the cap", async () => {
  const fake = enabledDb();
  let granted = 0;
  let grants = 0;
  let denials = 0;
  for (const micros of sizes(500)) {
    const r = await reserve(fake.db, { micros, now: NOW });
    if (r.ok) {
      granted += micros;
      grants += 1;
      assert.equal(r.reservedTotal, granted);
    } else {
      denials += 1;
      assert.equal(r.reason, "cap");
    }
    assert.ok(granted <= 2_000_000);
  }
  const spend = row(fake, "SELECT reserved_micros, paid_calls FROM instant_check_spend WHERE day = ?", DAY);
  assert.equal(spend.reserved_micros, granted);
  assert.equal(spend.paid_calls, grants);
  assert.ok(spend.reserved_micros <= 2_000_000);
  assert.ok(denials > 0, "the run should hit the cap");
  assert.ok(granted > 1_900_000, "small reservations should keep filling up to the cap");
});

test("a reservation exactly reaching the cap succeeds; one micro more is denied", async () => {
  const fake = enabledDb();
  assert.deepEqual(await reserve(fake.db, { micros: 1_999_999, now: NOW }), { ok: true, reservedTotal: 1_999_999 });
  assert.deepEqual(await reserve(fake.db, { micros: 1, now: NOW }), { ok: true, reservedTotal: 2_000_000 });
  assert.deepEqual(await reserve(fake.db, { micros: 1, now: NOW }), { ok: false, reason: "cap" });
});

test("the migration's default control row (kill_switch = 1) blocks every reservation", async () => {
  const fake = createFakeD1();
  assert.equal(row(fake, "SELECT kill_switch FROM instant_check_control WHERE id = 1").kill_switch, 1);
  assert.deepEqual(await reserve(fake.db, { micros: 10_000, now: NOW }), { ok: false, reason: "kill_switch" });
  assert.equal(await killSwitchActive(fake.db), true);
  const spend = row(fake, "SELECT reserved_micros, paid_calls FROM instant_check_spend WHERE day = ?", DAY);
  assert.equal(spend.reserved_micros, 0);
  assert.equal(spend.paid_calls, 0);
});

test("a missing control row blocks", async () => {
  const fake = createFakeD1();
  fake.sqlite.exec("DELETE FROM instant_check_control");
  assert.deepEqual(await reserve(fake.db, { micros: 10_000, now: NOW }), { ok: false, reason: "kill_switch" });
  assert.equal(await killSwitchActive(fake.db), true);
});

test("killSwitchActive is false only when the row says kill_switch = 0", async () => {
  const fake = enabledDb();
  assert.equal(await killSwitchActive(fake.db), false);
  fake.sqlite.exec("UPDATE instant_check_control SET kill_switch = 2");
  assert.equal(await killSwitchActive(fake.db), true);
  fake.failWhen = () => true;
  assert.equal(await killSwitchActive(fake.db), true);
});

test("a lowered daily_cap_micros (100000) is honored", async () => {
  const fake = enabledDb();
  fake.sqlite.exec("UPDATE instant_check_control SET daily_cap_micros = 100000");
  let granted = 0;
  for (let i = 0; i < 20; i++) {
    const r = await reserve(fake.db, { micros: 15_000, now: NOW });
    if (r.ok) granted += 15_000;
    else assert.equal(r.reason, "cap");
  }
  assert.equal(granted, 90_000);
  assert.equal(row(fake, "SELECT reserved_micros FROM instant_check_spend").reserved_micros, 90_000);
});

test("the CHECK constraint refuses a control row above the hard cap", () => {
  const fake = enabledDb();
  assert.throws(() => fake.sqlite.exec("UPDATE instant_check_control SET daily_cap_micros = 5000000"), /CHECK/);
  assert.equal(row(fake, "SELECT daily_cap_micros FROM instant_check_control").daily_cap_micros, 2_000_000);
});

test("MIN(HARD_CAP) still holds when the control table was tampered without its CHECK", async () => {
  const fake = createFakeD1();
  fake.sqlite.exec(`
    DROP TABLE instant_check_control;
    CREATE TABLE instant_check_control (id INTEGER PRIMARY KEY, kill_switch INTEGER, daily_cap_micros INTEGER, updated_at TEXT);
    INSERT INTO instant_check_control VALUES (1, 0, 50000000, NULL);
  `);
  let granted = 0;
  for (let i = 0; i < 30; i++) {
    const r = await reserve(fake.db, { micros: 100_000, now: NOW });
    if (r.ok) granted += 100_000;
  }
  assert.equal(granted, 2_000_000);
  assert.deepEqual(await reserve(fake.db, { micros: 1, now: NOW }), { ok: false, reason: "cap" });
});

test("D1 throwing on any statement denies with reason 'error'", async () => {
  for (const pattern of [/INSERT OR IGNORE/, /^\s*UPDATE/, /./]) {
    const fake = enabledDb();
    fake.failWhen = (sql) => pattern.test(sql);
    assert.deepEqual(await reserve(fake.db, { micros: 10_000, now: NOW }), { ok: false, reason: "error" });
  }
});

test("a denied reservation whose follow-up read throws is still denied", async () => {
  const fake = createFakeD1();
  fake.failWhen = (sql) => /^SELECT kill_switch/.test(sql);
  assert.deepEqual(await reserve(fake.db, { micros: 10_000, now: NOW }), { ok: false, reason: "error" });
});

test("micros must be a positive safe integer", async () => {
  const fake = enabledDb();
  for (const micros of [0, -1, 1.5, NaN, Infinity, "10000", null, undefined, 2 ** 53]) {
    assert.deepEqual(await reserve(fake.db, { micros, now: NOW }), { ok: false, reason: "error" }, String(micros));
  }
  assert.equal(fake.calls.length, 0);
});

test("days are independent: a full day does not block the next UTC day", async () => {
  const fake = enabledDb();
  assert.equal((await reserve(fake.db, { micros: 2_000_000, now: NOW })).ok, true);
  assert.equal((await reserve(fake.db, { micros: 1, now: NOW })).ok, false);
  const r = await reserve(fake.db, { micros: 10_000, now: Date.parse("2026-11-26T00:00:01Z") });
  assert.deepEqual(r, { ok: true, reservedTotal: 10_000 });
});

test("settle releases the unused part of a reservation", async () => {
  const fake = enabledDb();
  await reserve(fake.db, { micros: 15_000, now: NOW });
  assert.deepEqual(await settle(fake.db, { day: DAY, reservedMicros: 15_000, actualMicros: 4_200, now: NOW }), { ok: true, adjusted: -10_800 });
  assert.equal(row(fake, "SELECT reserved_micros FROM instant_check_spend").reserved_micros, 4_200);
});

test("settle adds the excess when the call cost more than reserved", async () => {
  const fake = enabledDb();
  await reserve(fake.db, { micros: 10_000, now: NOW });
  await settle(fake.db, { day: DAY, reservedMicros: 10_000, actualMicros: 13_500, now: NOW });
  assert.equal(row(fake, "SELECT reserved_micros FROM instant_check_spend").reserved_micros, 13_500);
});

test("settle never takes the total below zero", async () => {
  const fake = enabledDb();
  await reserve(fake.db, { micros: 5_000, now: NOW });
  fake.sqlite.exec("UPDATE instant_check_spend SET reserved_micros = 1000");
  await settle(fake.db, { day: DAY, reservedMicros: 5_000, actualMicros: 0, now: NOW });
  assert.equal(row(fake, "SELECT reserved_micros FROM instant_check_spend").reserved_micros, 0);
});

test("settle keeps the reservation when the actual cost is unknown", async () => {
  const fake = enabledDb();
  await reserve(fake.db, { micros: 15_000, now: NOW });
  fake.reset();
  for (const actualMicros of [null, undefined, -1, 1.5, NaN, "4000"]) {
    assert.deepEqual(await settle(fake.db, { day: DAY, reservedMicros: 15_000, actualMicros, now: NOW }), { ok: true, adjusted: 0 });
  }
  assert.equal(fake.calls.length, 0);
  assert.equal(row(fake, "SELECT reserved_micros FROM instant_check_spend").reserved_micros, 15_000);
});

test("settle reports a D1 error instead of throwing", async () => {
  const fake = enabledDb();
  fake.failWhen = () => true;
  const r = await settle(fake.db, { day: DAY, reservedMicros: 15_000, actualMicros: 1_000, now: NOW });
  assert.equal(r.ok, false);
  assert.ok(r.error instanceof Error);
});
