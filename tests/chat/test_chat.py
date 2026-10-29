#!/usr/bin/env python3
"""End-to-end test of the site chat relay against a local `wrangler pages dev`.

Driven from Python rather than curl: the payloads are nested JSON and the shell
quoting produced malformed bodies that read as real 400s.
"""
import json, sqlite3, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone

BASE = "http://localhost:8799"
SECRET = "local-test-secret"
OPERATOR_CHAT = 1111111111
DB = sys.argv[1]
SCHEMA = sys.argv[2]

passed = failed = 0
def ck(label, expected, actual):
    global passed, failed
    if expected == actual:
        print(f"  ok   {label:<52} {actual!r}"); passed += 1
    else:
        print(f"  FAIL {label:<52} expected {expected!r}, got {actual!r}"); failed += 1

def call(method, path, payload=None, headers=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    data = json.dumps(payload).encode() if payload is not None else None
    try:
        with urllib.request.urlopen(req, data) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body or b"{}")
        except json.JSONDecodeError:
            return e.code, {"raw": body.decode("utf8", "replace")[:200]}

def sql(query):
    con = sqlite3.connect(DB)
    try:
        return con.execute(query).fetchone()
    finally:
        con.close()

def run_sql(query):
    con = sqlite3.connect(DB)
    con.execute(query); con.commit(); con.close()

def touch_now(conversation_id):
    """Reset the flood-guard window to this instant.

    The guard compares against last_activity_at, which is written before the
    Telegram push. How long that push takes therefore decides whether a
    back-to-back send is inside the window, which made this
    environment-dependent: fast with a dud token, slow with a real one."""
    ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    run_sql("UPDATE chat_conversations SET last_activity_at='%s' WHERE id='%s'" % (ts, conversation_id))

def webhook(message, secret=SECRET):
    return call("POST", "/api/chat/telegram", {"message": message},
                {"X-Telegram-Bot-Api-Secret-Token": secret})

# Fresh tables so the per-IP rate-limit assertions are deterministic.
con = sqlite3.connect(DB)
con.executescript("DROP TABLE IF EXISTS chat_messages; DROP TABLE IF EXISTS chat_conversations; DELETE FROM performance_events;")
con.executescript(open(SCHEMA).read())
con.commit(); con.close()

print("\n== 1. start a conversation ==")
status, r = call("POST", "/api/chat/start", {
    "text": "Hi, do you work with dental practices?",
    "page_path": "/pricing?utm_source=x#frag",
    "attr_referrer_host": "chatgpt.com",
    "attr_landing_page": "/pricing",
}, {"CF-Connecting-IP": "203.0.113.9"})
ck("start -> 200", 200, status)
cid, token, code = r.get("id"), r.get("token"), r.get("code")
ck("uuid conversation id", 36, len(cid or ""))
ck("48-hex visitor token", 48, len(token or ""))
ck("4-char operator code", 4, len(code or ""))
ck("first message seq", 1, r.get("seq"))
ck("query/fragment stripped from page_path", "/pricing", sql(f"SELECT page_path FROM chat_conversations WHERE id='{cid}'")[0])

print("\n== 2. validation + auth ==")
ck("empty text -> 400", 400, call("POST", "/api/chat/start", {"text": "   "})[0])
ck("missing text -> 400", 400, call("POST", "/api/chat/start", {})[0])
ck("send wrong token -> 404", 404, call("POST", "/api/chat/send", {"id": cid, "token": "deadbeef", "text": "hi"})[0])
ck("send unknown id -> 404", 404, call("POST", "/api/chat/send", {"id": "00000000-0000-0000-0000-000000000000", "token": token, "text": "hi"})[0])
ck("poll wrong token -> 404", 404, call("GET", f"/api/chat/poll?id={cid}&token=nope&after=0")[0])
ck("email wrong token -> 404", 404, call("POST", "/api/chat/email", {"id": cid, "token": "bad", "email": "a@b.co"})[0])

print("\n== 3. follow-up, flood guard, body cap ==")
touch_now(cid)
ck("2nd message inside 700ms -> 429", 429,
   call("POST", "/api/chat/send", {"id": cid, "token": token, "text": "too fast"})[0])
ck("rejected message was not stored", 1, sql("SELECT COUNT(*) FROM chat_messages WHERE conversation_id='%s'" % cid)[0])
time.sleep(0.8)
ck("follow-up seq once paced", 2, call("POST", "/api/chat/send", {"id": cid, "token": token, "text": "Specifically local SEO."})[1].get("seq"))
time.sleep(0.8)
call("POST", "/api/chat/send", {"id": cid, "token": token, "text": "x" * 5000})
ck("body truncated to MAX_BODY", 2000, sql(f"SELECT MAX(LENGTH(body)) FROM chat_messages WHERE conversation_id='{cid}'")[0])

print("\n== 4. poll ==")
status, p = call("GET", f"/api/chat/poll?id={cid}&token={token}&after=0")
ck("poll -> 200", 200, status)
ck("returns all three visitor messages", 3, len(p["messages"]))
ck("all from visitor", ["visitor"] * 3, [m["sender"] for m in p["messages"]])
ck("seqs ascending", True, [m["seq"] for m in p["messages"]] == sorted(m["seq"] for m in p["messages"]))
ck("after= excludes older", 1, len(call("GET", f"/api/chat/poll?id={cid}&token={token}&after=2")[1]["messages"]))
ck("after=huge returns none", 0, len(call("GET", f"/api/chat/poll?id={cid}&token={token}&after=99999")[1]["messages"]))

print("\n== 5. webhook auth ==")
ck("no secret -> 401", 401, call("POST", "/api/chat/telegram", {})[0])
ck("wrong secret -> 401", 401, webhook({"message_id": 1, "chat": {"id": OPERATOR_CHAT}, "text": "x"}, secret="wrong")[0])
before = sql("SELECT COUNT(*) FROM chat_messages")[0]
ck("foreign chat accepted but ignored", 200, webhook({"message_id": 2, "chat": {"id": 999999}, "text": f"/r {code} injected"})[0])
ck("foreign chat wrote nothing", before, sql("SELECT COUNT(*) FROM chat_messages")[0])

print("\n== 6. operator reply via /r CODE ==")
reply = "Yes — several. Happy to walk you through it."
ck("/r accepted", 200, webhook({"message_id": 500, "chat": {"id": OPERATOR_CHAT}, "text": f"/r {code} {reply}"})[0])
msgs = call("GET", f"/api/chat/poll?id={cid}&token={token}&after=3")[1]["messages"]
ck("agent reply delivered", 1, len(msgs))
ck("sender is agent", "agent", msgs[0]["sender"] if msgs else None)
ck("body preserved exactly", reply, msgs[0]["body"] if msgs else None)
ck("lowercase code also resolves", 200, webhook({"message_id": 501, "chat": {"id": OPERATOR_CHAT}, "text": f"/r {code.lower()} second"})[0])
ck("second reply stored", 2, sql(f"SELECT COUNT(*) FROM chat_messages WHERE conversation_id='{cid}' AND sender='agent'")[0])

print("\n== 7. operator reply via native reply-to ==")
con = sqlite3.connect(DB); con.execute(f"UPDATE chat_messages SET tg_message_id=4242 WHERE conversation_id='{cid}' AND seq=1"); con.commit(); con.close()
webhook({"message_id": 502, "chat": {"id": OPERATOR_CHAT}, "text": "Reply by quoting.", "reply_to_message": {"message_id": 4242}})
ck("reply-to mapped to conversation", "Reply by quoting.",
   sql(f"SELECT body FROM chat_messages WHERE conversation_id='{cid}' AND sender='agent' ORDER BY seq DESC LIMIT 1")[0])

print("\n== 8. unmappable operator message ==")
before = sql("SELECT COUNT(*) FROM chat_messages")[0]
webhook({"message_id": 503, "chat": {"id": OPERATOR_CHAT}, "text": "random thought, no reply context"})
ck("orphan message stored nowhere", before, sql("SELECT COUNT(*) FROM chat_messages")[0])
webhook({"message_id": 504, "chat": {"id": OPERATOR_CHAT}, "text": "/r ZZZZ nobody"})
ck("unknown code stored nowhere", before, sql("SELECT COUNT(*) FROM chat_messages")[0])
ck("service message (no text) ignored", 200, webhook({"message_id": 505, "chat": {"id": OPERATOR_CHAT}, "forum_topic_created": {"name": "x"}})[0])

print("\n== 9. email capture ==")
ck("invalid email -> 400", 400, call("POST", "/api/chat/email", {"id": cid, "token": token, "email": "nope"})[0])
ck("no-tld email -> 400", 400, call("POST", "/api/chat/email", {"id": cid, "token": token, "email": "a@b"})[0])
ck("valid email -> 200", 200, call("POST", "/api/chat/email", {
    "id": cid, "token": token, "email": "Owner@Practice.com", "name": "Dana",
    "attr_referrer_host": "chatgpt.com", "attr_landing_page": "/pricing"})[0])
ck("stored lowercased", "owner@practice.com", sql(f"SELECT visitor_email FROM chat_conversations WHERE id='{cid}'")[0])
ck("name stored", "Dana", sql(f"SELECT visitor_name FROM chat_conversations WHERE id='{cid}'")[0])
ck("logged as generate_lead", 1, sql("SELECT COUNT(*) FROM performance_events WHERE form_id='chat' AND event_name='generate_lead'")[0])
ck("channel classified from referrer", "AI Assistant", sql("SELECT attributed_channel FROM performance_events WHERE form_id='chat'")[0])

print("\n== 10. stored conversation metadata ==")
ck("attribution on conversation", "AI Assistant", sql(f"SELECT attributed_channel FROM chat_conversations WHERE id='{cid}'")[0])
ck("ip stored only as sha256", 64, sql(f"SELECT LENGTH(ip_hash) FROM chat_conversations WHERE id='{cid}'")[0])
ck("raw ip absent from row", 0, sql(f"SELECT COUNT(*) FROM chat_conversations WHERE id='{cid}' AND ip_hash LIKE '%203.0.113.9%'")[0])
ck("raw token never stored", 0, sql(f"SELECT COUNT(*) FROM chat_conversations WHERE token_hash='{token}'")[0])
ck("token_hash is sha256 of token", 64, sql(f"SELECT LENGTH(token_hash) FROM chat_conversations WHERE id='{cid}'")[0])
ck("message_count tracked", sql(f"SELECT COUNT(*) FROM chat_messages WHERE conversation_id='{cid}'")[0],
   sql(f"SELECT message_count FROM chat_conversations WHERE id='{cid}'")[0])

print("\n== 11. /close ==")
ck("/close accepted", 200, webhook({"message_id": 600, "chat": {"id": OPERATOR_CHAT}, "text": f"/close {code}"})[0])
ck("status closed", "closed", sql(f"SELECT status FROM chat_conversations WHERE id='{cid}'")[0])
ck("send to closed -> 409", 409, call("POST", "/api/chat/send", {"id": cid, "token": token, "text": "still there?"})[0])
before = sql("SELECT COUNT(*) FROM chat_messages")[0]
webhook({"message_id": 601, "chat": {"id": OPERATOR_CHAT}, "text": f"/r {code} too late"})
ck("reply to closed not delivered", before, sql("SELECT COUNT(*) FROM chat_messages")[0])

print("\n== 12. per-IP conversation rate limit (cap 8/hr) ==")
codes = [call("POST", "/api/chat/start", {"text": f"flood {i}"}, {"CF-Connecting-IP": "198.51.100.7"})[0] for i in range(9)]
ck("9th start from same IP blocked", [200] * 8 + [429], codes)
ck("different IP unaffected", 200, call("POST", "/api/chat/start", {"text": "clean ip"}, {"CF-Connecting-IP": "198.51.100.8"})[0])

print(f"\npassed: {passed}   failed: {failed}")
sys.exit(1 if failed else 0)
