// Anthropic Messages API, claude-haiku-5-5 with the server web search tool
// capped at one use.

import { postJson, result, tokenCount } from "./http.js";

export const ENGINE = "claude-haiku";
export const MODEL = "claude-haiku-5-5";
export const URL = "https://api.anthropic.com/v1/messages";
export const API_VERSION = "2023-06-01";
// Reserved before the call. Expected ~$0.011; max_uses: 1 caps the search fee.
export const WORST_CASE_MICROS = 15_000;

// $0.10 / 1M input, $0.50 / 1M output, $0.010 per web search request.
export function costMicros(json) {
  const input = tokenCount(json?.usage?.input_tokens);
  const output = tokenCount(json?.usage?.output_tokens);
  if (input === null || output === null) return null;
  const searches = tokenCount(json?.usage?.server_tool_use?.web_search_requests) ?? 0;
  return Math.ceil((input * 10 + output * 50) / 100) + searches * 10_000;
}

export function buildRequest(prompt) {
  return {
    model: MODEL,
    max_tokens: 700,
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
  };
}

export function answerText(json) {
  return (Array.isArray(json?.content) ? json.content : [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

export async function run({ prompt, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const base = { engine: ENGINE, model: MODEL };
  if (!apiKey) return result({ ...base, status: "unavailable", errorCode: "key_missing" });
  const response = await postJson(URL, {
    headers: { "x-api-key": apiKey, "anthropic-version": API_VERSION },
    body: buildRequest(prompt),
    fetchImpl,
    timeoutMs,
  });
  if (!response.ok) return result({ ...base, errorCode: response.errorCode });
  const text = answerText(response.json);
  const actualMicros = costMicros(response.json);
  if (!text) return result({ ...base, actualMicros, errorCode: "empty_answer" });
  return result({ ...base, status: "succeeded", answerText: text, actualMicros });
}
