// Signup-email price line for the Stripe webhook. Pure JS: no Stripe, network,
// or Cloudflare runtime.
//
//   node --test tests/stripe-webhook/signup-price.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// package.json is "type": "commonjs" but Pages Functions are ESM, so Node can't
// import the file by path. It has no imports of its own, so a data: URL works.
const source = readFileSync(new URL("../../functions/api/stripe-webhook.js", import.meta.url));
const { PLANS, buildSignupPriceLine } = await import(
  `data:text/javascript;base64,${source.toString("base64")}`
);

test("Full Management without a discount shows the $1,249 list price", () => {
  const line = buildSignupPriceLine(PLANS.full_management, {
    amount_total: 124900,
    total_details: { amount_discount: 0 },
  });

  assert.equal(line, "$1,249/mo");
  assert.ok(!line.includes("$2,500"));
});

test("Full Management with a discount shows the paid amount and the list price", () => {
  const line = buildSignupPriceLine(PLANS.full_management, {
    amount_total: 99900,
    total_details: { amount_discount: 25000 },
  });

  assert.equal(line, "$999/mo (normally $1,249/mo)");
  assert.ok(!line.includes("$2,500"));
});

test("a discount with no finite amount_total falls back to the list price", () => {
  const line = buildSignupPriceLine(PLANS.full_management, {
    amount_total: null,
    total_details: { amount_discount: 25000 },
  });

  assert.equal(line, "$1,249/mo");
});
