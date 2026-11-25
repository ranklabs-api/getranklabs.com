// Instant check — page metrics from raw HTML, no DOM library.
//
// Produces the subset of ranklabs-app's crawler metrics (agents/crawler/index.js
// page.evaluate block + collectAgentReadinessSignals) that score.js reads, with
// the same field names and the same caps (visible_text 20000 chars per
// ranklabs-app@6ea7afb / #228, heading text 200 chars, schema_nodes 40 nodes /
// 64 KB, faq_pairs 50). It works on the served HTML, not a rendered DOM, so
// client-rendered content is invisible here — that errs toward a lower score,
// never a higher one.

const MAX_SCHEMA_NODES = 40;
const MAX_SCHEMA_BYTES = 64 * 1024;
const VISIBLE_TEXT_MAX = 20000;
const HEADING_TEXT_MAX = 200;
const MAX_FAQ_PAIRS = 50;
const FAQ_QUESTION_MAX = 300;
const FAQ_ANSWER_MAX = 1000;

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", copy: "©", reg: "®",
  trade: "™", middot: "·", bull: "•", laquo: "«", raquo: "»", deg: "°", times: "×",
};

export function decodeEntities(text) {
  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try {
        return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : match;
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named ?? match;
  });
}

const collapse = (text) => text.replace(/\s+/g, " ").trim();

// Elements whose content is never visible text.
const HIDDEN_BLOCK_RE = /<(script|style|noscript|template|svg|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// Tags that break text into separate runs in innerText.
const BLOCK_TAG_RE = /<\/?(address|article|aside|blockquote|br|button|dd|details|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|label|li|main|nav|ol|option|p|pre|section|select|summary|table|tbody|td|textarea|tfoot|th|thead|tr|ul)\b[^>]*>/gi;

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, " ");
}

// Tag markup → text, the way textContent/innerText would read it.
export function htmlToText(fragment) {
  return collapse(
    decodeEntities(
      String(fragment || "")
        .replace(HIDDEN_BLOCK_RE, " ")
        .replace(BLOCK_TAG_RE, " ")
        .replace(/<[^>]*>/g, ""),
    ),
  );
}

export function parseAttributes(tag) {
  const attrs = {};
  const inner = tag.replace(/^<[a-z0-9-]+/i, "").replace(/\/?>$/, "");
  for (const m of inner.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => parseAttributes(m[0]));
}

function relIncludes(attrs, value) {
  return (attrs.rel || "").toLowerCase().split(/\s+/).includes(value);
}

function bodyOf(html) {
  const open = html.search(/<body\b[^>]*>/i);
  const start = open >= 0 ? html.indexOf(">", open) + 1 : 0;
  const close = html.search(/<\/body\s*>/i);
  let body = html.slice(start, close > start ? close : html.length);
  // No <body>: drop any <head> so its title and meta text don't count.
  if (open < 0) body = body.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/i, " ");
  return body;
}

function isFaqPage(node) {
  const types = node && node["@type"];
  return Array.isArray(types) ? types.includes("FAQPage") : types === "FAQPage";
}

function jsonLd(html) {
  const blocks = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = parseAttributes(`<script ${m[1]}>`);
    if ((attrs.type || "").trim().toLowerCase() === "application/ld+json") blocks.push(m[2]);
  }
  const schemaTypes = [];
  const schemaNodes = [];
  let bytes = 0;
  let hasFaqSchema = false;
  const pushNode = (node) => {
    // Checked before the node/byte caps so a large FAQPage still registers.
    if (isFaqPage(node)) hasFaqSchema = true;
    if (!node || typeof node !== "object" || schemaNodes.length >= MAX_SCHEMA_NODES) return;
    let size = 0;
    try {
      size = JSON.stringify(node).length;
    } catch {
      return;
    }
    if (bytes + size > MAX_SCHEMA_BYTES) return;
    bytes += size;
    schemaNodes.push(node);
  };
  for (const block of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(block.trim() || "{}");
    } catch {
      continue; // malformed JSON-LD still counts toward has_schema, as in the crawler
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const types = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
      for (const type of types) if (type && !schemaTypes.includes(type)) schemaTypes.push(type);
      const graph = item && Array.isArray(item["@graph"]) ? item["@graph"] : null;
      if (graph) for (const node of graph) pushNode(node);
      else pushNode(item);
    }
  }
  return {
    has_schema: blocks.length > 0,
    schema_types: schemaTypes,
    schema_nodes: schemaNodes,
    has_faq_schema: hasFaqSchema || schemaTypes.includes("FAQPage"),
  };
}

// Candidate Q&A pairs from <dl><dt>/<dd> and <details><summary>, unfiltered.
// score.js decides which look like real questions and answers. Caps and field
// lengths match collectAgentReadinessSignals in ranklabs-app@6ea7afb.
export function extractFaqPairs(html) {
  const faqPairs = [];
  const pushPair = (question, answer, source) => {
    if (faqPairs.length >= MAX_FAQ_PAIRS) return;
    question = collapse(question).substring(0, FAQ_QUESTION_MAX);
    answer = collapse(answer).substring(0, FAQ_ANSWER_MAX);
    if (question && answer) faqPairs.push({ question, answer, source });
  };

  for (const dl of String(html || "").matchAll(/<dl\b[^>]*>([\s\S]*?)<\/dl\s*>/gi)) {
    for (const part of dl[1].split(/<dt\b[^>]*>/i).slice(1)) {
      const close = part.match(/<\/dt\s*>/i);
      if (!close) continue;
      const question = htmlToText(part.slice(0, close.index));
      const rest = part.slice(close.index + close[0].length);
      const answers = [...rest.matchAll(/<dd\b[^>]*>([\s\S]*?)<\/dd\s*>/gi)].map((m) => htmlToText(m[1]));
      pushPair(question, answers.filter(Boolean).join(" "), "dt");
    }
  }

  const source = String(html || "");
  const openRe = /<details\b[^>]*>/gi;
  let open;
  while ((open = openRe.exec(source))) {
    const start = open.index + open[0].length;
    let depth = 1;
    const hop = /<details\b[^>]*>|<\/details\s*>/gi;
    hop.lastIndex = start;
    let end = -1;
    let token;
    while ((token = hop.exec(source))) {
      depth += token[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        end = token.index;
        break;
      }
    }
    if (end < 0) break;
    const inner = source.slice(start, end);
    const summary = inner.match(/<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i);
    if (summary) {
      const body = inner.slice(0, summary.index) + inner.slice(summary.index + summary[0].length);
      pushPair(htmlToText(summary[1]), htmlToText(body), "summary");
    }
    openRe.lastIndex = end + 1;
  }
  return faqPairs;
}

// html → metrics. `headers` (lowercase names) adds x_robots_tag handling.
export function extractMetrics(rawHtml, { headers = {} } = {}) {
  const html = stripComments(String(rawHtml || ""));
  const scrubbed = html.replace(HIDDEN_BLOCK_RE, " ");

  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? collapse(decodeEntities(titleMatch[1].replace(/<[^>]*>/g, ""))) : "";

  const metas = tags(scrubbed, "meta");
  const metaNamed = (name) => metas.find((m) => (m.name || "").toLowerCase() === name);
  const meta_description = metaNamed("description")?.content ?? "";
  const meta_robots = metaNamed("robots")?.content ?? "";
  const has_og = metas.some((m) => (m.property || "").toLowerCase().startsWith("og:"));
  const has_viewport = !!metaNamed("viewport");
  const canonical = tags(scrubbed, "link").find((l) => relIncludes(l, "canonical"))?.href || "";

  const heading_outline = [...scrubbed.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)].map((m) => ({
    level: Number(m[1]),
    text: htmlToText(m[2]).substring(0, HEADING_TEXT_MAX),
  }));
  const h1_texts = heading_outline.filter((h) => h.level === 1).map((h) => h.text);

  const body = bodyOf(scrubbed);
  const visibleText = htmlToText(body);

  const imgs = tags(body, "img");
  const content_snippets = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)]
    .map((m) => htmlToText(m[1]))
    .filter(Boolean)
    .slice(0, 10)
    .map((text) => text.substring(0, 300));

  const x_robots_tag = String(headers["x-robots-tag"] || "");
  const noindex = /(^|[\s,])noindex([\s,]|$)/i.test(meta_robots) || /noindex/i.test(x_robots_tag);

  return {
    title,
    meta_description,
    h1_count: h1_texts.length,
    h1_texts,
    heading_outline,
    img_count: imgs.length,
    img_no_alt: imgs.filter((img) => !("alt" in img) || !img.alt.trim()).length,
    has_canonical: !!canonical,
    canonical,
    has_og,
    has_viewport,
    word_count: visibleText.split(/\s+/).filter(Boolean).length,
    visible_text: visibleText.substring(0, VISIBLE_TEXT_MAX),
    content_snippets,
    meta_robots,
    x_robots_tag,
    noindex,
    faq_pairs: extractFaqPairs(scrubbed),
    ...jsonLd(html),
  };
}

// Same-document <a href> values with whether each sits inside <nav>/<header>.
export function extractLinks(rawHtml) {
  const html = stripComments(String(rawHtml || "")).replace(HIDDEN_BLOCK_RE, " ");
  const navRanges = [...html.matchAll(/<(nav|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)].map((m) => [m.index, m.index + m[0].length]);
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const attrs = parseAttributes(m[0]);
    if (!attrs.href) continue;
    links.push({
      href: attrs.href.trim(),
      nav: navRanges.some(([start, end]) => m.index >= start && m.index < end),
      nofollow: relIncludes(attrs, "nofollow"),
    });
  }
  return links;
}
