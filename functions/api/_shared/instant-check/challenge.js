// Vendored from ranklabs-app@195f6e9 agents/lib/challenge-page.js (ESM port).
// hasChallengeSignature / isChallengePage / isPlainAuthPage are verbatim;
// plainAuthDropCap and crawlLooksBlocked({ allPages: true }) take
// (pages, home) instead of a crawl object, same rules. Detects bot-block / challenge pages (e.g. Cloudflare
// "Attention Required") so the instant check never scores block HTML as the
// site. crawl.js uses the prospect semantics: the homepage is blocked if
// isChallengePage (a bare 401/403 included); ANY subpage with a challenge
// signature blocks the whole crawl.

const HARD_BLOCK_STATUSES = new Set([401, 403, 429]);
const CHALLENGE_TITLE = /Attention Required|Just a moment/i;

function pageText(page) {
  const title = String((page && page.title) || "");
  const snippets = (page && page.content_snippets) || [];
  const first = Array.isArray(snippets) ? String(snippets[0] || "") : String(snippets);
  return { title, first };
}

// Cloudflare markers on the response: page.headers, page.metrics.headers or
// snake_case page.metrics (cf_ray).
function hasCloudflareHeader(page) {
  const sources = [page.headers, page.metrics && page.metrics.headers, page.metrics];
  return sources.some((h) => h && typeof h === "object" && Object.keys(h).some((k) =>
    /^cf[-_](ray|mitigated)$/i.test(k) && h[k] != null && h[k] !== ""));
}

// A real challenge, judged by content/headers (or 429), not by a bare 401/403:
// a members-only "Forbidden" subpage has no signature.
export function hasChallengeSignature(page) {
  if (!page) return false;
  const status = Number(page.status_code);
  if (status === 429) return true;
  const { title, first } = pageText(page);
  if (CHALLENGE_TITLE.test(title)) return true;
  if (status >= 400 && (/cloudflare/i.test(title + " " + first) || hasCloudflareHeader(page))) return true;
  return false;
}

export function isChallengePage(page) {
  if (!page) return false;
  if (HARD_BLOCK_STATUSES.has(Number(page.status_code))) return true;
  return hasChallengeSignature(page);
}

// 401/403 with no challenge signature: members-only / Forbidden, not a bot wall.
export function isPlainAuthPage(page) {
  return !!page && [401, 403].includes(Number(page.status_code)) && !hasChallengeSignature(page);
}

// Most plain 401/403 subpages that may be dropped before the crawl counts as
// blocked. Denominator: pages fetched in this crawl, homepage included.
export function plainAuthDropCap(pages, home) {
  const attempted = pages.length;
  const dropped = pages.filter((p) => p !== home && isPlainAuthPage(p)).length;
  return { attempted, cap: Math.max(3, Math.ceil(attempted * 0.25)), dropped };
}

// { allPages: true } semantics from the source: the homepage if
// isChallengePage, any other page with a challenge signature, or more plain
// 401/403 subpages than plainAuthDropCap allows.
export function crawlLooksBlocked(pages, home) {
  const blocked = pages.filter((p) => (p === home ? isChallengePage(p) : hasChallengeSignature(p)));
  const { dropped, cap } = plainAuthDropCap(pages, home);
  return blocked.length > 0 || dropped > cap;
}
