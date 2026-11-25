// Instant check — target URL guard.
//
// The crawl fetches whatever site a visitor types, from inside Cloudflare, so
// this is the SSRF boundary: only public-looking DNS names over http(s) on the
// default port. IP literals, internal/special-use names, userinfo and explicit
// ports are refused outright rather than resolved and checked, because a
// Worker cannot see what a name resolves to before fetch() connects. Every
// redirect hop is re-checked with the same rules (crawl.js).

const MAX_INPUT = 2048;
const MAX_HOST = 253;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

// Names that never belong to a public business site.
const SPECIAL_SUFFIXES = [
  "localhost", "local", "internal", "lan", "home.arpa", "intranet", "corp", "private",
  "test", "invalid", "example", "onion", "arpa",
];

// Mega-sites a visitor could paste by mistake (or to burn budget): their
// results are meaningless for a local business check. Subdomains included.
export const MEGA_DOMAINS = [
  "google.com", "youtube.com", "facebook.com", "instagram.com", "amazon.com", "wikipedia.org",
  "apple.com", "microsoft.com", "x.com", "twitter.com", "linkedin.com", "reddit.com", "yelp.com",
  "getranklabs.com",
];

function hasSuffix(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

export function bareDomain(host) {
  return String(host || "").toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

// true when `host` is the bare domain itself or its www. form — the only two
// hosts the crawl may touch for a given target.
export function sameSite(host, domain) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  return h === domain || h === `www.${domain}`;
}

// Checks a parsed URL against every rule. → null when acceptable, else reason.
function rejectReason(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme";
  if (url.username || url.password) return "userinfo";
  if (url.port) return "port";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "host";
  if (host.startsWith("[") || host.includes(":")) return "ip_literal";
  // WHATWG URL parsing already turns 0x7f.1, 2130706433 and friends into
  // dotted IPv4, so one pattern covers every IPv4 spelling.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return "ip_literal";
  if (host.length > MAX_HOST) return "host_too_long";
  const labels = host.split(".");
  if (labels.length < 2) return "single_label";
  if (!labels.every((label) => LABEL_RE.test(label))) return "host";
  if (/^\d+$/.test(labels[labels.length - 1])) return "ip_literal";
  if (SPECIAL_SUFFIXES.some((suffix) => hasSuffix(host, suffix))) return "special_use";
  if (MEGA_DOMAINS.some((domain) => hasSuffix(host, domain))) return "blocked_domain";
  return null;
}

// Parses an absolute URL and applies the same rules. Used for redirect hops
// and crawl links. → { ok: true, url, host, domain } or { ok: false, reason }
export function checkUrl(href) {
  let url;
  try {
    url = new URL(String(href));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const reason = rejectReason(url);
  if (reason) return { ok: false, reason };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return { ok: true, url, host, domain: bareDomain(host) };
}

// Visitor input → { ok: true, domain, origin, host } or { ok: false, reason }.
// Accepts "example.com", "www.example.com/path" or an http(s) URL. `domain` is
// the bare (no www.) name used for caching and rate limits; `origin` keeps the
// host as typed and is always https.
export function normalizeTarget(input) {
  if (typeof input !== "string") return { ok: false, reason: "invalid" };
  const raw = input.trim();
  if (!raw || raw.length > MAX_INPUT || /[\s\u0000-\u001f\\]/.test(raw)) return { ok: false, reason: "invalid" };

  let candidate = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (!/^https?:\/\//i.test(raw)) return { ok: false, reason: "scheme" };
  } else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw)) {
    // javascript:, mailto:, data:, file: … — anything with a scheme that isn't
    // a host:port pair.
    return { ok: false, reason: "scheme" };
  } else {
    if (raw.startsWith("/")) return { ok: false, reason: "invalid" };
    candidate = `https://${raw}`;
  }

  const checked = checkUrl(candidate);
  if (!checked.ok) return checked;
  return { ok: true, domain: checked.domain, host: checked.host, origin: `https://${checked.host}` };
}
