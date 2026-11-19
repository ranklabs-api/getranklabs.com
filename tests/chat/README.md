# Site chat relay tests

78 assertions over `functions/api/chat/*` — auth and token handling, operator
reply mapping by all three routes, rate limits, `/close`, email capture,
attribution, and the 30-minute idle expiry.

These drive a real `wrangler pages dev` against a real local D1 rather than
mocking the bindings, because every bug worth catching here lives in the SQL or
in the Pages Function contract, not in application logic a mock would exercise.

There is no npm `test` script on purpose: this needs a server, a seeded
database and `sqlite3`, so it is a deliberate local procedure, not something to
imply runs in CI.

## Running them

```bash
npm run build

# 1. serve, with a dud bot token so no notification leaves the machine
STATE=$(mktemp -d)
npx wrangler pages dev dist --port 8799 --persist-to "$STATE" \
  --d1 PERFORMANCE_DB \
  --binding CHAT_TELEGRAM_BOT_TOKEN=invalid:token \
            CHAT_TELEGRAM_WEBHOOK_SECRET=local-test-secret \
            TELEGRAM_CHAT_ID=1111111111 \
            CHAT_IP_SALT=local-salt &

# 2. one request, to make miniflare create the database file
curl -s -o /dev/null -X POST localhost:8799/api/chat/start \
  -H 'Content-Type: application/json' -d '{"text":"init"}'

# 3. seed it
DB=$(find "$STATE" -path '*D1*' -name '*.sqlite' ! -name metadata.sqlite | head -1)
sqlite3 "$DB" < db/chat-schema.sql
sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS performance_events (
  id TEXT PRIMARY KEY, customer_id TEXT, event_name TEXT, occurred_at TEXT,
  received_at TEXT, form_id TEXT, form_type TEXT, page_path TEXT,
  event_version INTEGER, referrer_url TEXT, referrer_host TEXT,
  landing_page TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  gclid TEXT, ga_client_id TEXT, attributed_channel TEXT);"

# 4. run; each file resets the chat tables first
python3 -I tests/chat/test_chat.py   "$DB" db/chat-schema.sql
python3 -I tests/chat/test_expiry.py "$DB" db/chat-schema.sql
```

`TELEGRAM_CHAT_ID` is a placeholder and must stay one — this repo is public.
The tests only need the binding and the fixture to agree, so any value works,
and a dud bot token means nothing is sent anywhere regardless.

Use the dud bot token. With a real one the tests still pass, but every message
attempts a live Telegram push, and `sendMessage` latency decides whether a
back-to-back send lands inside the 700ms flood-guard window — which is why
`test_chat.py` resets that window with `touch_now()` instead of trusting
wall-clock timing.

## Two traps these tests already fell into

- **Never build a timestamp cutoff with SQLite's `datetime('now', ...)`.** Rows
  store ISO8601 (`2026-10-29T18:00:00.000Z`); `datetime()` returns
  `2026-10-29 18:00:00`. `'T' > ' '` byte-wise, so such a comparison silently
  never matches and the assertion passes for the wrong reason.
- **Don't nest double-quoted JSON inside `"$(curl ...)"` in a shell harness.**
  The first version of these tests did, sent malformed bodies, and read the
  resulting `400 Invalid request body` as a real validation pass.
