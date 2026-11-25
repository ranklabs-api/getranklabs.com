// Instant check — email gate. Format check plus a disposable-provider
// blocklist. Free webmail is fine: plenty of small businesses run on Gmail.

import { DISPOSABLE_DOMAINS, DISPOSABLE_LABELS } from "./disposable-domains.js";

const MAX_EMAIL = 254;
const MAX_LOCAL = 64;
const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function isDisposable(domain) {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(i).join("."))) return true;
  }
  return labels.slice(0, -1).some((label) => DISPOSABLE_LABELS.has(label));
}

// → { ok: true, email, domain } (lowercased) or { ok: false, reason }
// reason: 'invalid' | 'too_long' | 'disposable'
export function checkEmail(input) {
  if (typeof input !== "string") return { ok: false, reason: "invalid" };
  const email = input.trim().toLowerCase();
  if (!email) return { ok: false, reason: "invalid" };
  if (email.length > MAX_EMAIL) return { ok: false, reason: "too_long" };
  const at = email.lastIndexOf("@");
  if (at <= 0 || email.indexOf("@") !== at) return { ok: false, reason: "invalid" };
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > MAX_LOCAL || !LOCAL_RE.test(local)) return { ok: false, reason: "invalid" };
  const labels = domain.split(".");
  if (domain.length > 253 || labels.length < 2 || !labels.every((label) => LABEL_RE.test(label))) {
    return { ok: false, reason: "invalid" };
  }
  if (!/^(xn--[a-z0-9-]+|[a-z]{2,63})$/.test(labels[labels.length - 1])) return { ok: false, reason: "invalid" };
  if (isDisposable(domain)) return { ok: false, reason: "disposable" };
  return { ok: true, email, domain };
}
