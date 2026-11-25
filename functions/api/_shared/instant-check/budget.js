// Instant check — global daily spend cap and kill switch.
//
// Every paid provider call reserves its worst-case cost here BEFORE the call is
// made, in one atomic D1 statement that can only succeed while the day's total
// stays within the cap. Everything fails closed: a missing control row, the
// kill switch, a D1 error or a bad amount all deny the reservation.
//
// Money is integer micro-dollars (1 USD = 1,000,000 micros).

// $2.00/day. The migration's CHECK bounds daily_cap_micros to the same value,
// and reserve() takes MIN() against this too, so neither a tampered control
// row nor a schema without the CHECK can raise the ceiling.
export const HARD_CAP_MICROS = 2_000_000;

export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function isoTime(now) {
  return new Date(now).toISOString();
}

// → { ok: true, reservedTotal } or { ok: false, reason: 'cap' | 'kill_switch' | 'error' }
export async function reserve(db, { micros, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(micros) || micros <= 0) return { ok: false, reason: "error" };
  try {
    const day = utcDay(now);
    const at = isoTime(now);
    await db
      .prepare("INSERT OR IGNORE INTO instant_check_spend (day, reserved_micros, paid_calls, updated_at) VALUES (?1, 0, 0, ?2)")
      .bind(day, at)
      .run();
    // A missing control row or kill_switch != 0 makes the subquery NULL, and
    // `x <= MIN(cap, NULL)` is NULL — no row matches, so the reservation is
    // denied without a separate check that could race the update.
    const row = await db
      .prepare(
        `UPDATE instant_check_spend
            SET reserved_micros = reserved_micros + ?1, paid_calls = paid_calls + 1, updated_at = ?3
          WHERE day = ?2
            AND reserved_micros + ?1 <= MIN(?4, (SELECT daily_cap_micros FROM instant_check_control WHERE id = 1 AND kill_switch = 0))
          RETURNING reserved_micros`,
      )
      .bind(micros, day, at, HARD_CAP_MICROS)
      .first();
    if (row && Number.isSafeInteger(row.reserved_micros)) return { ok: true, reservedTotal: row.reserved_micros };
  } catch {
    return { ok: false, reason: "error" };
  }
  // Denied. The follow-up read only labels the reason; it cannot grant.
  try {
    return { ok: false, reason: (await killSwitchActive(db, { throwOnError: true })) ? "kill_switch" : "cap" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// Corrects a reservation once the provider's real cost is known. Lower →
// release the difference (never below 0). Higher → add the excess, uncapped:
// the money was already spent, and the ledger has to say so. Unknown actual →
// keep the worst-case reservation.
export async function settle(db, { day, reservedMicros, actualMicros, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(actualMicros) || actualMicros < 0 || !Number.isSafeInteger(reservedMicros)) {
    return { ok: true, adjusted: 0 };
  }
  const delta = actualMicros - reservedMicros;
  if (delta === 0) return { ok: true, adjusted: 0 };
  try {
    await db
      .prepare("UPDATE instant_check_spend SET reserved_micros = MAX(0, reserved_micros + ?1), updated_at = ?3 WHERE day = ?2")
      .bind(delta, day, isoTime(now))
      .run();
    return { ok: true, adjusted: delta };
  } catch (error) {
    return { ok: false, error };
  }
}

// true unless the control row exists and says kill_switch = 0.
export async function killSwitchActive(db, { throwOnError = false } = {}) {
  try {
    const row = await db.prepare("SELECT kill_switch FROM instant_check_control WHERE id = 1").first();
    return !row || row.kill_switch !== 0;
  } catch (error) {
    if (throwOnError) throw error;
    return true;
  }
}
