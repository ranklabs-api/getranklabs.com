# Instant free AI visibility check (Lean v1): ships DISABLED

`POST /api/instant-check` (`functions/api/instant-check.js`) returns **404 for every method** unless `INSTANT_CHECK_ENABLED` is exactly `true`. The D1 control row also ships with `kill_switch = 1`, so even with the flag on, no paid provider call can run until an operator flips it. Enabling needs Josiah's GO.

## Request flow

1. Flag check: if off, return 404 before reading the body or touching D1 or fetch.
2. POST only (405). Same-origin only: `Origin` must be `https://getranklabs.com` or `https://www.getranklabs.com` (403). JSON body of at most 4 KB (400/413). No CORS headers. Every response is `no-store`.
3. Required config: `PERFORMANCE_DB`, `INSTANT_CHECK_TURNSTILE_SECRET`, `INSTANT_CHECK_IP_SALT` (16+ chars), and a `CF-Connecting-IP` header. Any one missing returns 503 with no outbound calls.
4. Turnstile siteverify (5s timeout). It must report success, action `instant_check`, and a getranklabs.com hostname. Otherwise 403, before any D1 read or write.
5. Validate the email (format plus disposable blocklist), the website (SSRF guard plus mega-domain blocklist), the business name, the service and the city. A bad field returns 400.
6. 24h D1 cache keyed by (domain, prompt_version). A hit is returned for $0 and costs no rate limit or budget.
7. Rate limits per UTC day, via atomic D1 upserts: 3 per hashed IP, 2 per hashed email, 1 per domain. A D1 error counts as limited. Over the limit returns 429.
8. $0 fetch crawl: robots.txt, the homepage, and up to 4 internal pages. Same host only, redirects re-validated, 5s per page, 1 MB per page. If the site is blocked or the crawl fails, the request is queued for manual follow-up with no probes.
9. Deterministic score: vendored `scoreEngines`, plus on-page findings.
10. Probes run in order: Perplexity sonar, then the second engine (`claude-haiku` by default, or `gpt-5-mini`). **Before each call** the worst-case cost is reserved atomically against the daily cap. If the reservation is denied (cap, kill switch or D1 error) or the key is missing, the run stops. The lead still gets the $0 score, and the request is stored as `queued_manual` with the reason.
11. Results are cached only when every probe succeeded.

**No email or notification is sent anywhere in this feature.** Queued leads sit in `instant_check_requests` (`status = 'queued_manual'`) for manual follow-up.

## The 7 abuse controls and how each fails closed

| # | Control | Fails closed how |
|---|---|---|
| 1 | WAF edge rate rule (`waf-rate-limit-rule.json`) | **Documented, not applied.** Applying it is a Cloudflare config change that needs GO. |
| 2 | Turnstile siteverify | A missing secret returns 503. A missing token, failed check, timeout, wrong action or wrong hostname returns 403. |
| 3 | 24h D1 domain cache | A read error counts as a miss, so the request goes through the fully gated path. |
| 4 | 3/IP/day + 1/domain/day (+2/email/day), salted SHA-256 IP and email hashes | A missing salt or missing client IP returns 503. A D1 error counts as limited. |
| 5 | Email gate with disposable-domain blocklist | An invalid or disposable address returns 400. |
| 6 | Atomic D1 daily spend counter, $2.00/day cap, kill switch | One `UPDATE … WHERE reserved + x <= MIN(2000000, cap where kill_switch = 0) RETURNING`. A missing row, kill switch or error means denied. The CHECK constraint and the MIN() keep a tampered row from raising the cap. |
| 7 | Isolated provider keys | The feature reads only its own `INSTANT_CHECK_*_API_KEY` names. A missing key stops before fetch. Each provider key should also carry its own monthly limit at the provider. |

## Bindings and env var names (names only)

- D1 binding: `PERFORMANCE_DB` (existing, D1 `ranklabs-leads`)
- Flags and config (plain vars): `INSTANT_CHECK_ENABLED` (`true` to enable; anything else means 404), `INSTANT_CHECK_SECOND_ENGINE` (`claude-haiku` default | `gpt-5-mini`)
- Secrets: `INSTANT_CHECK_TURNSTILE_SECRET`, `INSTANT_CHECK_IP_SALT`, `INSTANT_CHECK_PERPLEXITY_API_KEY`, `INSTANT_CHECK_ANTHROPIC_API_KEY`, and `INSTANT_CHECK_OPENAI_API_KEY` (only if the second engine is swapped to gpt-5-mini)
- Build-time public vars for the form: `PUBLIC_INSTANT_CHECK_FORM` (`true` to render), `PUBLIC_INSTANT_CHECK_TURNSTILE_SITE_KEY`

`src/components/InstantCheckForm.astro` is imported by no page, and a test asserts this. Its copy is placeholder only; Malon owns the site copy.

## Migration (UNAPPLIED)

`db/migrations/instant_check_0001_init.sql` is idempotent. It has **not** been applied. After GO it would be applied with:

```
npx wrangler d1 execute ranklabs-leads --remote --file=db/migrations/instant_check_0001_init.sql
```

## Enable checklist (every step needs Josiah's GO)

1. Create isolated provider keys with provider-side monthly limits, then set them as Pages secrets under the names above.
2. Set `INSTANT_CHECK_IP_SALT` (a random value of 32+ chars) and create the Turnstile widget (hostnames getranklabs.com and www). Set the secret and the public site key.
3. Apply the migration.
4. Apply and verify the WAF rule.
5. `UPDATE instant_check_control SET kill_switch = 0 WHERE id = 1;`
6. Set `INSTANT_CHECK_ENABLED=true`. Import the form only after Malon's copy review.

Kill it at any time with `UPDATE instant_check_control SET kill_switch = 1 WHERE id = 1;` (paid calls stop immediately) or by unsetting `INSTANT_CHECK_ENABLED` (404).

## Cost

| Engine | Worst-case reservation | Expected per call | Max calls/day at $2 if nothing settles |
|---|---:|---:|---:|
| Perplexity sonar | $0.010 | ~$0.005 | 200 |
| Claude haiku | $0.015 | ~$0.011 | 133 |
| GPT-5 mini (swap) | $0.040 | ~$0.02 | 50 |

Reservations are settled down to actual cost from provider usage. If usage is unknown, the reservation is kept. The cap holds at $2.00/day, which is at most $60/month.

## Vendored scoring

`functions/api/_shared/instant-check/score.js` is vendored from **ranklabs-app@195f6e9**. Do not edit its logic in place. To re-vendor, pin a new SHA, port the changed functions, update `PIN` in `tests/instant-check/fixtures/generate-golden.cjs`, regenerate the goldens with:

```
NODE_PATH=/path/to/ranklabs-app/node_modules node tests/instant-check/fixtures/generate-golden.cjs
```

(it `git archive`s the pinned tree, so the checkout isn't touched), then review the diffs.

## Tests

```
node --test 'tests/instant-check/*.test.mjs'
```

All HTTP is mocked, and D1 is faked with `node:sqlite` loading the real migration.

## Known gaps

- Limits reset per UTC day rather than over a rolling window.
- No DataForSEO metrics (deliberate).
- No notifications.
- Probe answers are directional snapshots.
- The WAF rule is not applied.
