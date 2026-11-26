import assert from "node:assert/strict";
import { test } from "node:test";
import { readLibrary } from "../../src/frontend/check/index.ts";
import { referenceOptions } from "../../src/frontend/check/node.ts";
import { checkFacts } from "../../src/runtime/facts.ts";
import { text, variant } from "../../src/runtime/value.ts";

const options = referenceOptions();
const Products = readLibrary(`pub type analytics = Ga4(string) | NoAnalytics
pub type site = {domain: string, locales: list<string>, analytics: analytics, launched: option<time>, every: duration}`,
  "Products", options.host!, { name: "Products" });
const withProducts = { ...options, libraries: { Products } };

test("a fact block states a value of the type its header names", () => {
  assert.ok(Products.ok, JSON.stringify(Products.diagnostics));
  const result = checkFacts(`{domain: "pixelate.run", locales: ["en", "fr"], analytics: Ga4("524979795"), launched: None, every: 3d}`, "Products.site", withProducts);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.diagnostics));
  assert.deepEqual(result.value, {
    type: "record",
    fields: {
      domain: text("pixelate.run"),
      locales: { type: "list", values: [text("en"), text("fr")] },
      analytics: variant("Ga4", text("524979795")),
      launched: variant("None"),
      every: { type: "duration", value: String(3 * 86_400_000) },
    },
  });
});

test("a fact block that does not fit its type says where, in the block as written", () => {
  const result = checkFacts(`{domain: 1, locales: [], analytics: NoAnalytics, launched: None, every: 1d}`, "Products.site", withProducts);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.diagnostics[0]!.span.start.line, 1);
});

test("a fact block holds only values: no names, participants, functions or templates", () => {
  for (const body of [
    `{domain: d, locales: [], analytics: NoAnalytics, launched: None, every: 1d}`,
    `{domain: \`x\${1}\`, locales: [], analytics: NoAnalytics, launched: None, every: 1d}`,
    `{domain: "a", locales: [], analytics: NoAnalytics, launched: None, every: 1d, who: @claude}`,
  ]) {
    const result = checkFacts(body, "Products.site", withProducts);
    assert.equal(result.ok, false, body);
  }
  assert.equal(checkFacts(`1`, "Products.nope", withProducts).ok, false);
  assert.equal(checkFacts(`1`, "not a type", withProducts).ok, false);
});
