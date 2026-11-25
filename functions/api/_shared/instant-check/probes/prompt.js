// Instant check — the one buyer-intent probe prompt.
//
// Built only from the visitor's service + city, never from the business name
// or anything on the crawled site: naming the business would hand the engine
// the answer, and site text would be a prompt-injection channel. Matches the
// neutral buyer phrasing of ranklabs-app's agents/ai-engine-probe prompts.

// Part of the cache key (cache.js): bump on ANY change to the template so a
// cached result is never served for a different prompt.
export const PROMPT_VERSION = 1;

export const FIELD_MAX = 60;

// Letters, digits, space and , . ' & - / only; whitespace collapsed; ≤ 60.
// Anything else becomes a space, so markup, quotes, colons and newlines
// cannot shape the prompt.
export function sanitizeField(input) {
  if (typeof input !== "string") return "";
  return input
    .normalize("NFKC")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^\p{L}\p{M}\p{N} ,.'&\-/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FIELD_MAX)
    .trim();
}

// → the prompt string, or null when either field sanitizes to nothing.
export function buildPrompt({ service, city } = {}) {
  const s = sanitizeField(service);
  const c = sanitizeField(city);
  if (!s || !c) return null;
  return `I'm looking for ${s} in ${c}. Which local businesses would you recommend? Name specific businesses and include their websites.`;
}
