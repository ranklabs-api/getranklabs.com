// Instant check — request log and paid-probe ledger writes.
//
// Both return { ok: true } or { ok: false, error } instead of throwing, so the
// caller decides whether a failed write matters; they never swallow it.

const REQUEST_COLUMNS = [
  "id", "created_at", "domain", "email", "business_name", "service", "city",
  "ip_hash", "status", "queue_reason", "result_json", "followed_up_at",
];

const PROBE_COLUMNS = [
  "id", "request_id", "day", "engine", "model", "reserved_micros", "actual_micros", "status", "created_at",
];

function insert(table, columns, row) {
  const placeholders = columns.map((_, i) => `?${i + 1}`).join(", ");
  const values = columns.map((column) => {
    const value = row[column];
    if (value === undefined) return null;
    if (value !== null && typeof value === "object") return JSON.stringify(value);
    return value;
  });
  return { sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`, values };
}

async function write(db, table, columns, row) {
  try {
    const { sql, values } = insert(table, columns, row || {});
    await db.prepare(sql).bind(...values).run();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function newId() {
  return crypto.randomUUID();
}

export function recordRequest(db, row) {
  return write(db, "instant_check_requests", REQUEST_COLUMNS, row);
}

export function recordProbe(db, row) {
  return write(db, "instant_check_probe_ledger", PROBE_COLUMNS, row);
}
