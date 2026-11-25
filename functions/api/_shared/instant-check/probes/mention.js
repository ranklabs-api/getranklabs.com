// Vendored from ranklabs-app@195f6e9 agents/ai-engine-probe/lib.js (ESM port):
// escapeRegExp, nameRegExp, normalizeDomain, extractUrls, hostOf, hostMatches,
// domainRegExp, excerpt, and detectMention without the competitor-alias part.
// Deterministic string matching on business name and domain host — no
// LLM-as-judge.

export const EXCERPT_MAX = 500;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "Colonoscopy KC" matches "colonoscopy kc", "Colonoscopy-KC" and
// "colonoscopykc" (separators between words are optional), but not
// "colonoscopy kcmo" — the match must end on a word boundary.
export function nameRegExp(name) {
  const words = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return null;
  return new RegExp(`(?<![a-z0-9])${words.map(escapeRegExp).join('[\\s\\-_.]*')}(?![a-z0-9])`, 'i');
}

export function normalizeDomain(domain) {
  return String(domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
}

// Every http(s) URL in the text, trailing punctuation and markdown closers trimmed.
export function extractUrls(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>"'()\[\]]+/gi)) {
    const url = m[0].replace(/[.,;:!?*_`]+$/, '');
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return null; }
}

function hostMatches(host, domain) {
  return Boolean(host && domain && (host === domain || host.endsWith(`.${domain}`)));
}

function domainRegExp(domain) {
  return new RegExp(`(?<![a-z0-9-])(www\\.)?${escapeRegExp(domain)}(?![a-z0-9-])`, 'i');
}

// mentioned: business name or the bare domain host appears.
// matchedUrls: http(s) URLs whose host is the domain (or a subdomain).
export function detectMention(text, { businessName, domain } = {}) {
  const body = String(text || '');
  const d = normalizeDomain(domain);
  const mentioned = [businessName].some((n) => { const re = nameRegExp(n); return re && re.test(body); })
    || Boolean(d && domainRegExp(d).test(body));
  const urls = extractUrls(body);
  const matchedUrls = d ? urls.filter((u) => hostMatches(hostOf(u), d)) : [];
  return { mentioned, matchedUrls };
}

export function excerpt(text, max = EXCERPT_MAX) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
