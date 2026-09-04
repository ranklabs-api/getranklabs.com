// Lead attribution — shared by every form endpoint in this site.
//
// SYNCED COPY. This file is byte-identical across all four customer sites:
//   sites/colonoscopykc, sites/getranklabs,
//   sites/onetakewondermarketing, sites/maritimedjp
// They are separate repos and separate Pages projects, so the code cannot be
// imported across them. Canonical reference copy lives at
// ranklabs-app/templates/lead-attribution.js, and
// `node scripts/check-attribution-sync.js` in ranklabs-app diffs them all.
// If you change one, change them all and re-run that check — divergence between
// copies of the same logic is this platform's defining historical failure.
//
// WHY THIS EXISTS: on 2026-09-03 Colonoscopy KC took a real form submission that
// GA4 had no record of — no session, no pageview of the contact page, no
// generate_lead event — while that page tracked normally on surrounding days.
// The visitor was running a blocker against googletagmanager.com. The lead was
// real and its source was unrecoverable, because performance_events stored only
// form_id / form_type / page_path.
//
// The page stashes first-touch attribution in sessionStorage using plain DOM
// APIs (no gtag, no third-party request), the form POSTs it here, and this
// module classifies it server-side. That path keeps working for exactly the
// visitors GA4 cannot see.

// Host -> channel. Deliberately mirrors GA4's sessionDefaultChannelGroup
// vocabulary so leads and sessions can be grouped the same way on the
// dashboard. AI Assistant is broken out on purpose: it is the channel these
// sites are being optimised for, and GA4 reports it separately too.
const SEARCH_HOSTS = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|yahoo\.[a-z.]+|ecosia\.org|brave\.com|startpage\.com|baidu\.com|yandex\.[a-z.]+)$/;
const SOCIAL_HOSTS = /(^|\.)(facebook\.com|m\.facebook\.com|instagram\.com|l\.instagram\.com|twitter\.com|x\.com|t\.co|linkedin\.com|lnkd\.in|reddit\.com|tiktok\.com|pinterest\.[a-z.]+|youtube\.com|nextdoor\.com)$/;
const AI_HOSTS = /(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com|perplexity\.ai|claude\.ai|anthropic\.com|gemini\.google\.com|copilot\.microsoft\.com|you\.com|poe\.com)$/;
const EMAIL_HOSTS = /(^|\.)(mail\.google\.com|outlook\.(live|office|com)[a-z.]*|mail\.yahoo\.com)$/;

// Returns a channel string, or null when there is genuinely nothing to go on.
// null is NOT "Direct". "Direct" is a real measurement (the browser sent no
// referrer); null means we captured nothing at all, and the two must never be
// conflated on a client-facing report.
export function classifyChannel({ referrerHost, utmSource, utmMedium, gclid, captured }) {
  const medium = (utmMedium || "").toLowerCase();
  if (gclid || medium === "cpc" || medium === "ppc" || medium === "paid") {
    return SOCIAL_HOSTS.test(referrerHost || "") ? "Paid Social" : "Paid Search";
  }
  if (medium === "email" || (utmSource || "").toLowerCase() === "newsletter") return "Email";
  const host = (referrerHost || "").toLowerCase();
  if (host) {
    // Order matters: the more specific host families must be tested before the
    // broad search-engine pattern. mail.google.com and gemini.google.com both
    // match `google.[a-z.]+`, so checking Search first would file webmail and
    // Gemini as Organic Search.
    if (AI_HOSTS.test(host)) return "AI Assistant";
    if (EMAIL_HOSTS.test(host)) return "Email";
    if (SEARCH_HOSTS.test(host)) return "Organic Search";
    if (SOCIAL_HOSTS.test(host)) return "Organic Social";
    return "Referral";
  }
  if (utmSource || utmMedium) return "Referral";
  // The capture script ran and found no referrer — a measured Direct visit.
  if (captured) return "Direct";
  return null;
}

// Pull the attr_* fields off a submitted payload and derive the channel.
// Accepts either a FormData (most sites) or a plain parsed-JSON object
// (getranklabs posts JSON) — the client sends the same flat attr_* keys either
// way, so endpoints do not care which shape they received.
// Returns the exact values the performance_events insert expects, so an
// endpoint never has to remember the column order.
export function readAttribution(source) {
  const isForm = source && typeof source.get === "function" && typeof source.has === "function";
  const get = (k) => {
    const v = isForm ? source.get("attr_" + k) : (source ? source["attr_" + k] : null);
    return v === null || v === undefined || v === "" ? null : String(v).slice(0, 512);
  };
  const has = (k) => (isForm ? source.has("attr_" + k) : !!(source && source["attr_" + k]));
  const referrerHost = get("referrer_host");
  const utmSource = get("utm_source");
  const utmMedium = get("utm_medium");
  const gclid = get("gclid");
  // Did the capture script run at all? Distinguishes a measured Direct visit
  // from no attribution data whatsoever.
  const captured = has("landing_page") || has("referrer_host") || has("referrer") || has("utm_source");
  return {
    referrer_url: get("referrer"),
    referrer_host: referrerHost,
    landing_page: get("landing_page"),
    utm_source: utmSource,
    utm_medium: utmMedium,
    utm_campaign: get("utm_campaign"),
    gclid,
    ga_client_id: get("ga_client_id"),
    attributed_channel: classifyChannel({ referrerHost, utmSource, utmMedium, gclid, captured }),
  };
}

// The columns readAttribution() fills, in insert order. Endpoints append
// `...ATTRIBUTION_COLUMNS.map((c) => attr[c])` to their bind() call.
export const ATTRIBUTION_COLUMNS = [
  "referrer_url", "referrer_host", "landing_page",
  "utm_source", "utm_medium", "utm_campaign", "gclid",
  "ga_client_id", "attributed_channel",
];
