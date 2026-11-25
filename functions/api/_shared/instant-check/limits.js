// Instant check — per-UTC-day rate limits in D1.
//
// Limits count uncached checks only (a cache hit never reaches consume()).
// Each consume() is one atomic upsert: the counter only moves while it is under
// the limit, and a missing RETURNING row means the bucket is full. A D1 error
// is treated as limited, so a broken limiter can never let traffic through.

export const LIMITS = { ip: 3, email: 2, domain: 1 };

const MIN_SALT_LENGTH = 16;

// → { ok: true, n } or { ok: false, reason: 'limited' | 'error' }
export async function consume(db, { bucket, day, limit } = {}) {
  if (typeof bucket !== "string" || !bucket || typeof day !== "string" || !Number.isSafeInteger(limit) || limit <= 0) {
    return { ok: false, reason: "error" };
  }
  try {
    const row = await db
      .prepare(
        `INSERT INTO instant_check_rate (bucket, day, n) VALUES (?1, ?2, 1)
           ON CONFLICT(bucket, day) DO UPDATE SET n = n + 1 WHERE n < ?3
         RETURNING n`,
      )
      .bind(bucket, day, limit)
      .first();
    if (row && Number.isSafeInteger(row.n) && row.n <= limit) return { ok: true, n: row.n };
    return { ok: false, reason: "limited" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// SHA-256 hex of `${salt}:${value}`. Throws without a real salt: an unsalted
// hash of an IPv4 address is reversible by enumeration, so callers must fail
// closed rather than store one.
export async function hashIdentifier(salt, value) {
  if (typeof salt !== "string" || salt.length < MIN_SALT_LENGTH) {
    throw new Error("hashIdentifier: salt missing or too short");
  }
  const data = new TextEncoder().encode(`${salt}:${String(value ?? "")}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function ipBucket(hash) {
  return `ip:${hash}`;
}

export function emailBucket(hash) {
  return `email:${hash}`;
}

export function domainBucket(bareDomain) {
  return `domain:${bareDomain}`;
}
