// OpenAI Responses API, gpt-5-mini with one web search (swap option for the
// second engine; see index.js).

import { countOutputItems, postJson, responsesText, result, tokenCount } from "./http.js";

export const ENGINE = "gpt-5-mini";
export const MODEL = "gpt-5-mini";
export const URL = "https://api.openai.com/v1/responses";
// Reserved before the call. Expected ~$0.014; headroom for a second search,
// which max_tool_calls should prevent but the API does not price-cap.
export const WORST_CASE_MICROS = 40_000;

// $0.25 / 1M input, $2.00 / 1M output, $0.010 per web_search_call item.
export function costMicros(json) {
  const input = tokenCount(json?.usage?.input_tokens);
  const output = tokenCount(json?.usage?.output_tokens);
  if (input === null || output === null) return null;
  const searches = countOutputItems(json, "web_search_call");
  return Math.ceil((input * 25 + output * 200) / 100) + searches * 10_000;
}

export function buildRequest(prompt) {
  return {
    model: MODEL,
    input: prompt,
    tools: [{ type: "web_search" }],
    max_tool_calls: 1,
    max_output_tokens: 700,
    reasoning: { effort: "low" },
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
