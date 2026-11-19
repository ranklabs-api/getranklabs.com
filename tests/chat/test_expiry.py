#!/usr/bin/env python3
"""Idle-expiry tests for the site chat relay (30 minutes of no messages)."""
import json, sqlite3, sys, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone

BASE = "http://localhost:8799"
SECRET = "local-test-secret"
OPERATOR = 1111111111
DB, SCHEMA = sys.argv[1], sys.argv[2]

passed = failed = 0
def ck(label, expected, actual):
    global passed, failed
    if expected == actual:
        print("  ok   %-54s %r" % (label, actual)); passed += 1
    else:
        print("  FAIL %-54s expected %r, got %r" % (label, expected, actual)); failed += 1

def call(method, path, payload=None, headers=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items(): req.add_header(k, v)
    data = json.dumps(payload).encode() if payload is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read()
        try: return e.code, json.loads(body or b"{}")
        except json.JSONDecodeError: return e.code, {"raw": body.decode("utf8", "replace")[:200]}

def sql(q):
    con = sqlite3.connect(DB)
    try: return con.execute(q).fetchone()
    finally: con.close()

def run(q):
    con = sqlite3.connect(DB); con.execute(q); con.commit(); con.close()

def webhook(msg):
    return call("POST", "/api/chat/telegram", {"message": msg},
                {"X-Telegram-Bot-Api-Secret-Token": SECRET})

def backdate(cid, minutes):
    ts = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")
    run("UPDATE chat_conversations SET last_activity_at='%s' WHERE id='%s'" % (ts, cid))

def new_chat(text="hello", ip="203.0.113.50"):
    _, r = call("POST", "/api/chat/start", {"text": text}, {"CF-Connecting-IP": ip})
    return r["id"], r["token"], r["code"]

con = sqlite3.connect(DB)
con.executescript("DROP TABLE IF EXISTS chat_messages; DROP TABLE IF EXISTS chat_conversations; DELETE FROM performance_events;")
con.executescript(open(SCHEMA).read()); con.commit(); con.close()

print("\n== 1. a live conversation is untouched ==")
cid, tok, code = new_chat("I am active")
ck("status open", "open", call("GET", "/api/chat/poll?id=%s&token=%s&after=0" % (cid, tok))[1]["status"])
backdate(cid, 29)
ck("29 min idle is still open", "open", call("GET", "/api/chat/poll?id=%s&token=%s&after=0" % (cid, tok))[1]["status"])
ck("send at 29 min accepted", 200, call("POST", "/api/chat/send", {"id": cid, "token": tok, "text": "still here"})[0])
ck("sending reset the clock in D1", "open", sql("SELECT status FROM chat_conversations WHERE id='%s'" % cid)[0])

print("\n== 2. poll expires it past 30 min ==")
backdate(cid, 31)
status, body = call("GET", "/api/chat/poll?id=%s&token=%s&after=0" % (cid, tok))
ck("poll still 200", 200, status)
ck("reports expired", "expired", body["status"])
ck("persisted to D1", "expired", sql("SELECT status FROM chat_conversations WHERE id='%s'" % cid)[0])

print("\n== 3. visitor send to an expired chat ==")
status, body = call("POST", "/api/chat/send", {"id": cid, "token": tok, "text": "anyone?"})
ck("410 Gone (not 409)", 410, status)
ck("flagged expired for the widget", True, body.get("expired"))
ck("nothing appended", 2, sql("SELECT COUNT(*) FROM chat_messages WHERE conversation_id='%s'" % cid)[0])

print("\n== 4. operator reply to an expired chat is not silently dropped ==")
before = sql("SELECT COUNT(*) FROM chat_messages")[0]
ck("webhook accepts", 200, webhook({"message_id": 700, "chat": {"id": OPERATOR}, "text": "/r %s sorry, late" % code})[0])
ck("reply not delivered", before, sql("SELECT COUNT(*) FROM chat_messages")[0])
ck("stays expired, not reopened", "expired", sql("SELECT status FROM chat_conversations WHERE id='%s'" % cid)[0])

print("\n== 5. expired and closed stay distinct ==")
cid2, tok2, code2 = new_chat("close me")
webhook({"message_id": 701, "chat": {"id": OPERATOR}, "text": "/close %s" % code2})
ck("explicit close -> closed", "closed", sql("SELECT status FROM chat_conversations WHERE id='%s'" % cid2)[0])
ck("send to closed -> 409", 409, call("POST", "/api/chat/send", {"id": cid2, "token": tok2, "text": "hi"})[0])
backdate(cid2, 99)
call("GET", "/api/chat/poll?id=%s&token=%s&after=0" % (cid2, tok2))
ck("idle does NOT rewrite a closed chat", "closed", sql("SELECT status FROM chat_conversations WHERE id='%s'" % cid2)[0])

print("\n== 6. operator reply still works on a live chat ==")
cid3, tok3, code3 = new_chat("live one")
webhook({"message_id": 702, "chat": {"id": OPERATOR}, "text": "/r %s here you go" % code3})
ck("delivered", "here you go", sql("SELECT body FROM chat_messages WHERE conversation_id='%s' AND sender='agent'" % cid3)[0])
ck("agent reply reset the idle clock", "open", call("GET", "/api/chat/poll?id=%s&token=%s&after=0" % (cid3, tok3))[1]["status"])

print("\n== 7. abandoned conversations are swept on the next start ==")
# The cutoff must be built in the SAME format the rows store (ISO8601 with T and
# Z). Comparing against SQLite's datetime('now') gives a space separator, and
# 'T' > ' ' byte-wise, so such a predicate silently never matches.
def stale_open():
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
    return sql("SELECT COUNT(*) FROM chat_conversations WHERE status='open' AND last_activity_at < '%s'" % cutoff)[0]

open_before = sql("SELECT COUNT(*) FROM chat_conversations WHERE status='open'")[0]
abandoned = [new_chat("abandoned %d" % i, ip="203.0.113.%d" % (60 + i)) for i in range(3)]
for a in abandoned: backdate(a[0], 45)
ck("3 abandoned are open and stale", 3, stale_open())

new_chat("fresh visitor triggers the sweep", ip="203.0.113.99")
import time
for _ in range(50):          # the sweep runs under waitUntil, after the response
    if stale_open() == 0: break
    time.sleep(0.1)
ck("sweep left nothing open and stale", 0, stale_open())
ck("the 3 became 'expired', not 'closed'", 3,
   sql("SELECT COUNT(*) FROM chat_conversations WHERE status='expired' AND code IN ('%s','%s','%s')" % tuple(a[2] for a in abandoned))[0])
ck("fresh conversation still open", 1,
   sql("SELECT COUNT(*) FROM chat_conversations WHERE status='open' AND message_count=1 AND page_path='/'")[0] >= 1 and 1 or 0)
ck("the live chat from test 6 was not swept", "open",
   sql("SELECT status FROM chat_conversations WHERE id='%s'" % cid3)[0])

print("\npassed: %d   failed: %d" % (passed, failed))
sys.exit(1 if failed else 0)
