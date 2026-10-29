#!/usr/bin/env bash
# Point the site-chat bot's webhook at a deployment.
#
#   CHAT_TELEGRAM_BOT_TOKEN=... CHAT_TELEGRAM_WEBHOOK_SECRET=... \
#     scripts/set-chat-webhook.sh https://getranklabs.com
#
# A bot can have EITHER a webhook or getUpdates long-polling, never both.
# The Hermes gateway long-polls @tg_easybot (bot id 8542811180) for all operator
# comms, so setting a webhook on that bot would silently kill its control
# channel. The guard below refuses to run against it. Site chat has its own bot
# (@Getranklabs_bot) for exactly this reason.
set -euo pipefail

BASE_URL="${1:-}"
if [[ -z "$BASE_URL" ]]; then
  echo "usage: $0 <https://base-url>   (no trailing slash)" >&2
  exit 64
fi
: "${CHAT_TELEGRAM_BOT_TOKEN:?set CHAT_TELEGRAM_BOT_TOKEN}"
: "${CHAT_TELEGRAM_WEBHOOK_SECRET:?set CHAT_TELEGRAM_WEBHOOK_SECRET}"

HERMES_BOT_ID=8542811180
BOT_ID="${CHAT_TELEGRAM_BOT_TOKEN%%:*}"
if [[ "$BOT_ID" == "$HERMES_BOT_ID" ]]; then
  echo "REFUSING: that is the Hermes gateway bot (@tg_easybot)." >&2
  echo "A webhook would stop its getUpdates polling and break operator comms." >&2
  exit 1
fi

API="https://api.telegram.org/bot${CHAT_TELEGRAM_BOT_TOKEN}"
echo "bot:      $(curl -fsS "$API/getMe" | sed -n 's/.*"username":"\([^"]*\)".*/@\1/p')"
echo "endpoint: ${BASE_URL}/api/chat/telegram"

curl -fsS -X POST "$API/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "$(printf '{"url":"%s/api/chat/telegram","secret_token":"%s","allowed_updates":["message"],"drop_pending_updates":true}' \
        "$BASE_URL" "$CHAT_TELEGRAM_WEBHOOK_SECRET")" \
  | sed -n 's/.*"description":"\([^"]*\)".*/result: \1/p'

echo "--- getWebhookInfo ---"
curl -fsS "$API/getWebhookInfo" \
  | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]; print("\n".join(f"{k}: {v}" for k,v in r.items() if k in ("url","pending_update_count","last_error_message","last_error_date")))'
