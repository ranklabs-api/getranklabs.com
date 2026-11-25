// Shared POST for the probe adapters: hard timeout, no throw, and nothing in
// the result that could carry a request header (the API key) into a log.

// → { ok: true, json } or { ok: false, errorCode }
export async function postJson(url, { headers, body, fetchImpl = globalThis.fetch, timeoutMs = 20000 }) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      timeout,
    ]);
    if (!response.ok) {
      try {
        await response.body?.cancel?.();
      } catch {
        /* nothing to release */
      }
      return { ok: false, errorCode: `http_${response.status}` };
    }
    let json;
    try {
      json = await Promise.race([response.json(), timeout]);
    } catch {
      return { ok: false, errorCode: timedOut ? "timeout" : "bad_json" };
    }
    if (!json || typeof json !== "object") return { ok: false, errorCode: "bad_json" };
    return { ok: true, json };
  } catch {
    return { ok: false, errorCode: timedOut ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

export function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Joins output[].content[] output_text parts (Responses-style APIs).
export function responsesText(json) {
  const parts = [];
  for (const item of Array.isArray(json?.output) ? json.output : []) {
    if (item?.type !== "message") continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type === "output_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n").trim();
}

export function countOutputItems(json, type) {
  return (Array.isArray(json?.output) ? json.output : []).filter((item) => item?.type === type).length;
}

export function result(fields) {
  return { status: "failed", engine: null, model: null, answerText: null, actualMicros: null, errorCode: null, ...fields };
}
