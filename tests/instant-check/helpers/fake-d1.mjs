// A Cloudflare D1 stand-in over node:sqlite, built from the real migration
// file so the tests exercise the schema (CHECKs, defaults, the seeded control
// row) that would actually be applied.
//
// Implements the subset of the D1 API the instant check uses:
// prepare(sql).bind(...).first(column?) / .run() / .all(), plus batch().
// Every statement is logged in `calls`; `failWhen(sql)` returning true makes
// that statement throw, the way a D1 outage or timeout would surface.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const MIGRATION_URL = new URL("../../../db/migrations/instant_check_0001_init.sql", import.meta.url);

export function migrationSql() {
  return readFileSync(MIGRATION_URL, "utf8");
}

const plain = (row) => (row == null ? row : { ...row });
const isWrite = (sql) => /^\s*(insert|update|delete|replace)\b/i.test(sql);

export function createFakeD1({ migrate = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  if (migrate) sqlite.exec(migrationSql());

  const fake = {
    sqlite,
    calls: [],
    failWhen: null,
    get writes() {
      return fake.calls.filter((c) => isWrite(c.sql));
    },
    reset() {
      fake.calls.length = 0;
    },
    db: {
      prepare(sql) {
        return statement(sql, []);
      },
      async batch(statements) {
        const out = [];
        for (const s of statements) out.push(await s.all());
        return out;
      },
    },
  };

  function exec(sql, args, mode) {
    fake.calls.push({ sql, args, mode });
    if (fake.failWhen && fake.failWhen(sql, args)) throw new Error("D1_ERROR: injected failure");
    const stmt = sqlite.prepare(sql);
    if (mode === "first") return stmt.all(...args).map(plain)[0] ?? null;
    if (mode === "all") return stmt.all(...args).map(plain);
    if (/\breturning\b/i.test(sql)) {
      const results = stmt.all(...args).map(plain);
      return { results, changes: results.length };
    }
    const info = stmt.run(...args);
    return { results: [], changes: Number(info.changes) };
  }

  function statement(sql, args) {
    return {
      bind(...values) {
        return statement(sql, values);
      },
      async first(column) {
        const row = exec(sql, args, "first");
        if (column === undefined) return row;
        return row ? row[column] ?? null : null;
      },
      async all() {
        return { success: true, results: exec(sql, args, "all"), meta: {} };
      },
      async run() {
        const { results, changes } = exec(sql, args, "run");
        return { success: true, results, meta: { changes } };
      },
    };
  }

  return fake;
}

// Convenience reads for assertions, bypassing the call log.
export function rows(fake, sql, ...args) {
  return fake.sqlite.prepare(sql).all(...args).map(plain);
}

export function row(fake, sql, ...args) {
  return rows(fake, sql, ...args)[0] ?? null;
}
