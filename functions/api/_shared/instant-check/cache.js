// Instant check — 24h result cache keyed on (bare domain, prompt version).
//
// A hit is served for $0 and consumes no rate limit or budget. Any read error
// is a miss: the caller then goes through the normal, fully gated path.

import { PROMPT_VERSION } from "./probes/prompt.js";

export { PROMPT_VERSION };

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// → the cached result object, or null.
export async function getCached(db, domain, now = Date.now()) {
  try {
    const row = await db
      .prepare(
        "SELECT result_json FROM instant_check_cache WHERE domain = ?1 AND prompt_version = ?2 AND expires_at > ?3",
      )
      .bind(domain, PROMPT_VERSION, new Date(now).toISOString())
      .first();
    if (!row || typeof row.result_json !== "string") return null;
    const result = JSON.parse(row.result_json);
    return result && typeof result === "object" ? result : null;
  } catch {
    return null;
  }
}

// → { ok: true } or { ok: false, error }
export async function putCached(db, domain, result, now = Date.now()) {
  try {
    await db
      .prepare(
        `INSERT OR REPLACE INTO instant_check_cache (domain, prompt_version, result_json, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(
        domain,
        PROMPT_VERSION,
        JSON.stringify(result),
        new Date(now).toISOString(),
        new Date(now + CACHE_TTL_MS).toISOString(),
      )
      .run();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
