import { reserve, settle, utcDay } from './_shared/instant-check/budget.js';
import { LIMITS, consume, hashIdentifier } from './_shared/instant-check/limits.js';
import { getCached, putCached } from './_shared/instant-check/cache.js';
import { newId, recordRequest, recordProbe } from './_shared/instant-check/requests.js';
import { normalizeTarget } from './_shared/instant-check/url.js';
import { checkEmail } from './_shared/instant-check/email.js';
import { fetchCrawl } from './_shared/instant-check/crawl.js';
import { scoreSite, onPageFindings } from './_shared/instant-check/score.js';
import { ENGINES, selectEngines, engineKey } from './_shared/instant-check/probes/index.js';
import { sanitizeField, buildPrompt } from './_shared/instant-check/probes/prompt.js';
import { detectMention, excerpt } from './_shared/instant-check/probes/mention.js';

const ALLOWED_HOSTS = ['getranklabs.com', 'www.getranklabs.com'];
const TURNSTILE_TIMEOUT_MS = 5000;

// Same-origin only: a browser POST from our own pages carries Origin
// https://getranklabs.com (or www). Anything else, including no Origin, is refused.
function sameOrigin(request) {
  try { return ALLOWED_HOSTS.includes(new URL(request.headers.get('Origin') || '').host); } catch { return false; }
}

const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function readBody(request) {
  if (Number(request.headers.get('content-length')) > 4096) return { error: 413 };
  if (!request.body) return { error: 400 };
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return { error: 413 }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { error: 400 };
  } catch { return { error: 400 }; }
}

export async function handleInstantCheck(request, env = {}, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (env.INSTANT_CHECK_ENABLED !== 'true') return reply({ error: 'not_found' }, 404);
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  if (!sameOrigin(request)) return reply({ error: 'forbidden' }, 403);
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') || '')) return reply({ error: 'invalid_content_type' }, 400);
  const body = await readBody(request);
  if (body.error) return reply({ error: body.error === 413 ? 'too_large' : 'invalid_body' }, body.error);
  const db = env.PERFORMANCE_DB;
  if (!db || !env.INSTANT_CHECK_TURNSTILE_SECRET || typeof env.INSTANT_CHECK_IP_SALT !== 'string' || env.INSTANT_CHECK_IP_SALT.length < 16) return reply({ error: 'unavailable' }, 503);
  const input = body.value;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  // No client IP means the per-IP limit can't be enforced: fail closed.
  if (!ip) return reply({ error: 'unavailable' }, 503);
  const token = input['cf-turnstile-response'] || input.turnstile_token;
  if (!token || typeof token !== 'string') return reply({ error: 'verification_failed' }, 403);
  try {
    const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: env.INSTANT_CHECK_TURNSTILE_SECRET, response: token, remoteip: ip }), signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS) });
    const result = await response.json();
    if (!response.ok || result.success !== true || result.action !== 'instant_check' || !ALLOWED_HOSTS.includes(result.hostname)) throw new Error('verification');
  } catch { return reply({ error: 'verification_failed' }, 403); }
  const email = checkEmail(input.email);
  const target = normalizeTarget(input.website);
  const business = typeof input.business_name === 'string' ? input.business_name.trim() : '';
  const service = sanitizeField(input.service), city = sanitizeField(input.city);
  for (const [field, valid] of [['email', email.ok], ['website', target.ok], ['business_name', business && business.length <= 100], ['service', service], ['city', city]]) {
    if (!valid) return reply({ error: 'invalid_field', field }, 400);
  }
  const at = new Date(now).toISOString(), day = utcDay(now), id = newId();
  let ipHash, emailHash;
  try { ipHash = await hashIdentifier(env.INSTANT_CHECK_IP_SALT, ip); emailHash = await hashIdentifier(env.INSTANT_CHECK_IP_SALT, email.email.toLowerCase()); }
  catch { return reply({ error: 'unavailable' }, 503); }
  const row = { id, created_at: at, domain: target.domain, email: email.email, business_name: business, service, city, ip_hash: ipHash };
  const cached = await getCached(db, target.domain, now);
  if (cached) { await recordRequest(db, { ...row, status: 'cached', result_json: cached }); return reply({ ...cached, status: 'cached' }); }
  for (const [bucket, limit] of [[`ip:${ipHash}`, LIMITS.ip], [`email:${emailHash}`, LIMITS.email], [`domain:${target.domain}`, LIMITS.domain]]) {
    if (!(await consume(db, { bucket, day, limit })).ok) {
      await recordRequest(db, { ...row, status: 'rejected', queue_reason: 'rate_limited' });
      return reply({ error: 'rate_limited' }, 429);
    }
  }
  const crawl = await fetchCrawl(target.origin, { fetchImpl });
  if (!crawl.ok || crawl.blocked) {
    const reason = crawl.blocked ? 'crawl_blocked' : 'crawl_failed';
    await recordRequest(db, { ...row, status: 'queued_manual', queue_reason: reason });
    return reply({ status: 'queued', reason });
  }
  const score = scoreSite(crawl.pages), findings = onPageFindings(crawl.pages, crawl.robots_txt), probes = [];
  let reason = null;
  const prompt = buildPrompt({ service, city });
  for (const name of selectEngines(env)) {
    const engine = ENGINES[name], apiKey = engineKey(env, name);
    if (!apiKey) { reason = 'probe_key_missing'; break; }
    const reservation = await reserve(db, { micros: engine.WORST_CASE_MICROS, now });
    if (!reservation.ok) { reason = { cap: 'daily_cap', kill_switch: 'kill_switch', error: 'budget_error' }[reservation.reason]; break; }
    const result = await engine.run({ prompt, apiKey, fetchImpl });
    await recordProbe(db, { id: newId(), request_id: id, day, engine: name, model: engine.MODEL, reserved_micros: engine.WORST_CASE_MICROS, actual_micros: result.actualMicros, status: result.status, created_at: at });
    await settle(db, { day, reservedMicros: engine.WORST_CASE_MICROS, actualMicros: result.actualMicros, now });
    if (result.status !== 'succeeded') { reason = 'probe_failed'; break; }
    const mention = detectMention(result.answerText, { businessName: business, domain: target.domain });
    probes.push({ engine: name, mentioned: mention.mentioned, cited: mention.matchedUrls.length > 0, matched_urls: mention.matchedUrls, excerpt: excerpt(result.answerText) });
  }
  if (reason) {
    const result = { status: 'partial', score, findings, probes_done: probes, queued: true, reason };
    await recordRequest(db, { ...row, status: 'queued_manual', queue_reason: reason, result_json: result });
    return reply(result);
  }
  const result = { status: 'completed', score, findings, probes, methodology: 'directional_v0', checked_at: at };
  await putCached(db, target.domain, result, now);
  await recordRequest(db, { ...row, status: 'completed', result_json: result });
  return reply(result);
}

export function onRequest(context) {
  return handleInstantCheck(context.request, context.env, { fetchImpl: globalThis.fetch });
}
