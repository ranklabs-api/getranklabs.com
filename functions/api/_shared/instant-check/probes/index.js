// Instant check — probe engine registry.
//
// Two engines per check: Perplexity Sonar always, plus one second engine
// chosen by INSTANT_CHECK_SECOND_ENGINE ('claude-haiku', the default, or
// 'gpt-5-mini'). Each engine has its own isolated key env var; the generic
// provider key names used elsewhere are never read.

import * as anthropic from "./anthropic.js";
import * as openai from "./openai.js";
import * as perplexity from "./perplexity.js";

export const ENGINES = Object.freeze({
  "perplexity-sonar": { ...perplexity, keyEnv: "INSTANT_CHECK_PERPLEXITY_API_KEY" },
  "claude-haiku": { ...anthropic, keyEnv: "INSTANT_CHECK_ANTHROPIC_API_KEY" },
  "gpt-5-mini": { ...openai, keyEnv: "INSTANT_CHECK_OPENAI_API_KEY" },
});

export const SECOND_ENGINES = ["claude-haiku", "gpt-5-mini"];
export const DEFAULT_SECOND_ENGINE = "claude-haiku";

export function selectEngines(env = {}) {
  const requested = String(env?.INSTANT_CHECK_SECOND_ENGINE || "").trim();
  const second = SECOND_ENGINES.includes(requested) ? requested : DEFAULT_SECOND_ENGINE;
  return ["perplexity-sonar", second];
}

export function engineKey(env, id) {
  const value = env?.[ENGINES[id]?.keyEnv];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
