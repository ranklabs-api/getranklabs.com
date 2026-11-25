// Perplexity Agent API, perplexity/sonar with one web search.

import { countOutputItems, postJson, responsesText, result, tokenCount } from "./http.js";

export const ENGINE = "perplexity-sonar";
export const MODEL = "perplexity/sonar";
export const URL = "https://api.perplexity.ai/v1/agent";
// Reserved before the call. Expected ~$0.005; 2× headroom.
export const WORST_CASE_MICROS = 10_000;

// $0.25 / 1M input, $2.50 / 1M output, $0.0025 per web_search call. One search
// is assumed when the response doesn't itemize them (max_tool_calls is 1).
export function costMicros(json) {
  const input = tokenCount(json?.usage?.input_tokens);
  const output = tokenCount(json?.usage?.output_tokens);
  if (input === null || output === null) return null;
  const searches = countOutputItems(json, "web_search_call") || 1;
  return Math.ceil((input * 25 + output * 250) / 100) + searches * 2_500;
}

export function buildRequest(prompt) {
  return {
    model: MODEL,
    input: prompt,
    tools: [{ type: "web_search" }],
    max_tool_calls: 1,
    max_output_tokens: 700,
  };
}

export async function run({ prompt, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const base = { engine: ENGINE, model: MODEL };
  if (!apiKey) return result({ ...base, status: "unavailable", errorCode: "key_missing" });
  const response = await postJson(URL, {
    headers: { authorization: `Bearer ${apiKey}` },
    body: buildRequest(prompt),
    fetchImpl,
    timeoutMs,
  });
  if (!response.ok) return result({ ...base, errorCode: response.errorCode });
  const answerText = responsesText(response.json);
  const actualMicros = costMicros(response.json);
  if (!answerText) return result({ ...base, actualMicros, errorCode: "empty_answer" });
  return result({ ...base, status: "succeeded", answerText, actualMicros });
}
