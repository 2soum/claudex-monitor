import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { priceFor, MODEL_PRICING } from "./pricing.js";

describe("priceFor", () => {
  test("matches Opus 4.7 rates from claude.com/pricing (2026-04)", () => {
    const p = priceFor("claude-opus-4-7");
    assert.equal(p.input, 5);
    assert.equal(p.output, 25);
    assert.equal(p.cacheWrite, 6.25);
    assert.equal(p.cacheRead, 0.5);
  });

  test("matches Sonnet 4.6 rates", () => {
    const p = priceFor("claude-sonnet-4-6");
    assert.equal(p.input, 3);
    assert.equal(p.output, 15);
  });

  test("matches Haiku 4.5 rates", () => {
    const p = priceFor("claude-haiku-4-5");
    assert.equal(p.input, 1);
    assert.equal(p.output, 5);
  });

  test("falls back to default for unknown models", () => {
    const p = priceFor("claude-unknown-model-xyz");
    assert.deepEqual(p, MODEL_PRICING.default);
  });

  test("substring match works (full model id with suffixes)", () => {
    const p = priceFor("claude-opus-4-7-20260315");
    assert.equal(p.input, 5);
  });
});
