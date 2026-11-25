// Instant check — probe engine registry.
//
// Lean v1 always runs two engines: Perplexity Sonar plus Claude Haiku.
// INSTANT_CHECK_SECOND_ENGINE cannot select another engine in this build —
// gpt-5-mini stays in the tree (openai.js + ENGINES registry) but unkeyed
// and unselectable until an explicit future change adds it to SECOND_ENGINES.
// Isolated key env names only; the generic provider key names used elsewhere
// are never read.

import * as anthropic from "./anthropic.js";
import * as openai from "./openai.js";
import * as perplexity from "./perplexity.js";

export const ENGINES = Object.freeze({
  "perplexity-sonar": { ...perplexity, keyEnv: "INSTANT_CHECK_PERPLEXITY_API_KEY" },
  "claude-haiku": { ...anthropic, keyEnv: "INSTANT_CHECK_ANTHROPIC_API_KEY" },
  "gpt-5-mini": { ...openai, keyEnv: "INSTANT_CHECK_OPENAI_API_KEY" },
});

// Lean v1 selectable second engines. gpt-5-mini is intentionally absent.
export const SECOND_ENGINES = ["claude-haiku"];
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
