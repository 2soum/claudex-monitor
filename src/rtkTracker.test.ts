import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeRTKGains } from "./rtkTracker.js";
import type { AggregatedUsage } from "./usageCollector.js";

function mkAgg(partial: Partial<AggregatedUsage>): AggregatedUsage {
  return {
    totalTokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    totalCostUSD: 0,
    totalRequests: 0,
    models: [],
    session: {
      windowStart: new Date().toISOString(),
      windowResetAt: new Date().toISOString(),
      windowLimit: null,
      windowUsed: 0,
      windowPercent: 0,
      windowMessages: 0,
    },
    weeklyCostUSD: new Array(7).fill(0),
    topProjects: [],
    hourlyUsageUSD: new Array(24).fill(0),
    monthlyCostUSD: 0,
    monthStartEpoch: Date.now(),
    ...partial,
  };
}

describe("computeRTKGains", () => {
  test("empty aggregate yields zero gains", () => {
    const g = computeRTKGains(mkAgg({}));
    assert.equal(g.cacheHitRatio, 0);
    assert.equal(g.tokensSavedCache, 0);
    assert.equal(g.costSavedCache, 0);
  });

  test("cache hit ratio = cacheRead / (input + cacheRead)", () => {
    const g = computeRTKGains(
      mkAgg({
        totalTokens: { input: 1_000, output: 0, cacheCreation: 0, cacheRead: 9_000 },
      }),
    );
    assert.equal(g.cacheHitRatio, 0.9);
  });

  test("tokens saved = 90% of cache reads (10% effective cost)", () => {
    const g = computeRTKGains(
      mkAgg({
        totalTokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 1_000_000 },
      }),
    );
    assert.equal(g.tokensSavedCache, 900_000);
  });

  test("cost saved uses Opus rate for Opus-model cache reads", () => {
    // 1M cache reads on Opus (input $5/M). Savings = 1M * 5 * 0.9 / 1M = $4.50
    const g = computeRTKGains(
      mkAgg({
        totalTokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 1_000_000 },
        models: [
          {
            model: "claude-opus-4-7",
            tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 1_000_000 },
            requests: 10,
            costUSD: 0.5,
          },
        ],
      }),
    );
    assert.ok(Math.abs(g.costSavedCache - 4.5) < 1e-9, `got ${g.costSavedCache}`);
  });

  test("cost saved uses Sonnet rate for Sonnet-model cache reads", () => {
    // 1M cache reads on Sonnet ($3/M input). Savings = 1M * 3 * 0.9 / 1M = $2.70
    const g = computeRTKGains(
      mkAgg({
        totalTokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 1_000_000 },
        models: [
          {
            model: "claude-sonnet-4-6",
            tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 1_000_000 },
            requests: 5,
            costUSD: 0.3,
          },
        ],
      }),
    );
    assert.ok(Math.abs(g.costSavedCache - 2.7) < 1e-9, `got ${g.costSavedCache}`);
  });
});
