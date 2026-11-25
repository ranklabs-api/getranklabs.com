// Instant check — $0 fetch crawl: robots.txt + homepage + up to 4 internal pages.
//
// No browser, no third-party crawl API. Every request goes only to the target's
// own bare domain or its www. host: redirects are followed by hand (at most
// MAX_REDIRECTS hops) and every hop is re-checked with url.js plus the
// same-site rule, so a redirect to 127.0.0.1, an internal name or another site
// is refused rather than followed. Bodies are read through a byte cap and
// every page has a hard timeout.
//
// A challenge / bot wall anywhere aborts the crawl (blocked: true): block HTML
// is never scored as the site.

import { crawlLooksBlocked, hasChallengeSignature, isChallengePage } from "./challenge.js";
import { extractLinks, extractMetrics } from "./extract.js";
import { checkUrl, normalizeTarget, sameSite } from "./url.js";

export const USER_AGENT = "RankLabsInstantCheck/1.0 (+https://getranklabs.com)";
export const MAX_REDIRECTS = 3;
export const ROBOTS_MAX_BYTES = 100 * 1024;

const DEFAULTS = { maxPages: 5, timeoutMs: 5000, maxBytes: 1_000_000 };
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NON_HTML_EXTENSIONS = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|xml|json|txt|jpe?g|png|gif|webp|svg|ico|mp3|wav|mp4|mov|avi|webm)$/i;
const PRIORITY_GROUPS = [/\babout\b/i, /\bservices?\b/i, /\bfaqs?\b/i, /\bcontact\b/i];

class Timeout extends Error {}

function isHtmlType(contentType) {
  const type = String(contentType || "").toLowerCase();
  return type.includes("text/html") || type.includes("application/xhtml+xml");
}

function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new Timeout());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Timeout());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(signal.aborted ? new Timeout() : error); },
    );
  });
}

async function discard(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    /* nothing to release */
  }
}

// Reads at most maxBytes of the body, cancelling the stream past the cap.
export async function readCapped(response, maxBytes, signal) {
  const reader = response.body && typeof response.body.getReader === "function" ? response.body.getReader() : null;
  if (!reader) {
    const bytes = new TextEncoder().encode(await raceAbort(response.text(), signal));
    return { text: new TextDecoder().decode(bytes.subarray(0, maxBytes)), bytes: Math.min(bytes.length, maxBytes), truncated: bytes.length > maxBytes };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
      if (total + chunk.byteLength > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    if (truncated || signal.aborted) reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(joined), bytes: total, truncated };
}

function pickHeaders(headers) {
  const out = {};
  for (const name of ["content-type", "x-robots-tag", "cf-ray", "cf-mitigated"]) {
    const value = headers?.get?.(name);
    if (value) out[name] = value;
  }
  return out;
}

// One GET with manual, re-validated redirects.
// → { ok: true, url, status, headers, text, truncated } or { ok: false, reason }
async function fetchPage(startUrl, domain, { fetchImpl, timeoutMs, maxBytes, accept }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const { signal } = controller;
  try {
    let current = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const checked = checkUrl(current);
      if (!checked.ok || !sameSite(checked.host, domain)) return { ok: false, reason: hop ? "redirect_refused" : "url_refused" };
      const response = await raceAbort(
        fetchImpl(checked.url.href, {
          method: "GET",
          redirect: "manual",
          headers: { "user-agent": USER_AGENT, accept },
          signal,
        }),
        signal,
      );
      if (response.type === "opaqueredirect" || response.status === 0) {
        return { ok: false, reason: "redirect_opaque" };
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers?.get?.("location");
        await discard(response);
        if (!location) return { ok: false, reason: "redirect_no_location" };
        try {
          current = new URL(location, checked.url).href;
        } catch {
          return { ok: false, reason: "redirect_refused" };
        }
        continue;
      }
      const body = await readCapped(response, maxBytes, signal);
      return { ok: true, url: checked.url.href, status: response.status, headers: pickHeaders(response.headers), ...body };
    }
    return { ok: false, reason: "too_many_redirects" };
  } catch (error) {
    return { ok: false, reason: error instanceof Timeout || signal.aborted ? "timeout" : "fetch_error" };
  } finally {
    clearTimeout(timer);
  }
}

// Fetched response → a page in ranklabs-app's crawl page shape.
function toPage(fetched) {
  const contentType = fetched.headers["content-type"] || "";
  const metrics = extractMetrics(isHtmlType(contentType) ? fetched.text : "", { headers: fetched.headers });
  return {
    url: fetched.url,
    status_code: fetched.status,
    title: metrics.title,
    content_type: contentType,
    noindex: metrics.noindex,
    content_snippets: [metrics.title, metrics.meta_description, ...metrics.content_snippets].filter(Boolean),
    schema_types: metrics.schema_types,
    schema_nodes: metrics.schema_nodes,
    has_faq_schema: !!metrics.has_faq_schema,
    faq_pairs: metrics.faq_pairs || [],
    headers: fetched.headers,
    truncated: fetched.truncated,
    metrics,
  };
}

function pageKey(url) {
  const u = new URL(url);
  return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`;
}

// Homepage links → up to `limit` internal page URLs. Order: the first link
// for each of about / services / faq / contact, then any other such links,
// then <nav>/<header> links, then the rest, all in document order.
export function selectLinks(html, baseUrl, domain, limit) {
  const homeKey = pageKey(baseUrl);
  const seen = new Set([homeKey]);
  const candidates = [];
  for (const link of extractLinks(html)) {
    if (link.nofollow) continue;
    let url;
    try {
      url = new URL(link.href, baseUrl);
    } catch {
      continue;
    }
    url.hash = "";
    const checked = checkUrl(url.href);
    if (!checked.ok || !sameSite(checked.host, domain)) continue;
    if (NON_HTML_EXTENSIONS.test(url.pathname)) continue;
    const key = pageKey(url.href);
    if (seen.has(key)) continue;
    seen.add(key);
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep the encoded form */
    }
    candidates.push({ url: url.href, path: path.replace(/[-_/]+/g, " "), nav: link.nav });
  }

  const picked = [];
  const take = (c) => {
    if (picked.length < limit && !picked.includes(c)) picked.push(c);
  };
  for (const group of PRIORITY_GROUPS) {
    const first = candidates.find((c) => group.test(c.path));
    if (first) take(first);
  }
  for (const c of candidates) if (PRIORITY_GROUPS.some((g) => g.test(c.path))) take(c);
  for (const c of candidates) if (c.nav) take(c);
  for (const c of candidates) take(c);
  return picked.map((c) => c.url);
}

const strip = ({ headers, content_snippets, truncated, ...page }) => ({ ...page, content_snippets });

// → { ok: true, blocked: false, reason: null, url, robots_txt, pages }
//   { ok: false, blocked: true, reason: 'challenge', robots_txt, pages: [] }
//   { ok: false, blocked: false, reason: 'homepage_<why>', robots_txt, pages: [] }
export async function fetchCrawl(origin, options = {}) {
  const { fetchImpl = globalThis.fetch, maxPages, timeoutMs, maxBytes } = { ...DEFAULTS, ...options };
  const target = normalizeTarget(origin);
  if (!target.ok) return { ok: false, blocked: false, reason: "invalid_target", robots_txt: "", pages: [] };
  const { domain } = target;
  const base = { fetchImpl, timeoutMs, maxBytes };

  const robots = await fetchPage(`${target.origin}/robots.txt`, domain, { ...base, maxBytes: Math.min(maxBytes, ROBOTS_MAX_BYTES), accept: "text/plain" });
  const robots_txt = robots.ok && robots.status >= 200 && robots.status < 300 && !isHtmlType(robots.headers["content-type"])
    ? robots.text
    : "";

  const fail = (reason, blocked = false) => ({ ok: false, blocked, reason, robots_txt, pages: [] });

  const homeFetch = await fetchPage(`${target.origin}/`, domain, { ...base, accept: "text/html,application/xhtml+xml" });
  if (!homeFetch.ok) return fail(`homepage_${homeFetch.reason}`);
  const home = toPage(homeFetch);
  if (isChallengePage(home)) return fail("challenge", true);
  if (home.status_code < 200 || home.status_code >= 300) return fail("homepage_status");
  if (!isHtmlType(home.content_type)) return fail("homepage_not_html");
  home.metrics.robots_txt = robots_txt;

  const attempted = [home];
  const pages = [home];
  for (const url of selectLinks(homeFetch.text, homeFetch.url, domain, Math.max(0, maxPages - 1))) {
    const fetched = await fetchPage(url, domain, { ...base, accept: "text/html,application/xhtml+xml" });
    if (!fetched.ok) continue;
    const page = toPage(fetched);
    attempted.push(page);
    if (hasChallengeSignature(page)) return fail("challenge", true);
    if (page.status_code >= 200 && page.status_code < 300 && isHtmlType(page.content_type)) pages.push(page);
  }
  if (crawlLooksBlocked(attempted, home)) return fail("challenge", true);

  return { ok: true, blocked: false, reason: null, url: home.url, robots_txt, pages: pages.map(strip) };
}
