import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateFromJSONL,
  computeCost,
  friendlyProjectName,
  parseUsageOutput,
} from "./usageCollector.js";

describe("friendlyProjectName", () => {
  test("keeps last 2 path segments", () => {
    assert.equal(
      friendlyProjectName("/Users/foo/Documents/my-app/server"),
      "my-app/server",
    );
  });
  test("returns single segment when only one", () => {
    assert.equal(friendlyProjectName("foo"), "foo");
  });
  test("handles trailing slashes", () => {
    assert.equal(friendlyProjectName("/a/b/c/"), "b/c");
  });
});

describe("computeCost", () => {
  test("Opus 4.7 output-heavy turn", () => {
    // 1k input + 10k output → 1k*$5/M + 10k*$25/M = $0.005 + $0.25 = $0.255
    const cost = computeCost("claude-opus-4-7", {
      input: 1_000,
      output: 10_000,
      cacheCreation: 0,
      cacheRead: 0,
    });
    assert.ok(Math.abs(cost - 0.255) < 1e-9, `got ${cost}`);
  });

  test("cache reads are 10% of input rate", () => {
    // 1M cache read on Opus: 1M * 0.5 / 1M = $0.50
    const cost = computeCost("claude-opus-4-7", {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 1_000_000,
    });
    assert.ok(Math.abs(cost - 0.5) < 1e-9, `got ${cost}`);
  });
});

describe("parseUsageOutput", () => {
  test("extracts percent and limit from typical /usage text", () => {
    const text = `Session tokens: 145,231 / 500,000\nCurrent 5-hour usage: 29%`;
    const { windowPercent, windowLimit } = parseUsageOutput(text);
    assert.equal(windowPercent, 29);
    assert.equal(windowLimit, 500_000);
  });

  test("returns nulls on empty output", () => {
    const { windowPercent, windowLimit } = parseUsageOutput("");
    assert.equal(windowPercent, null);
    assert.equal(windowLimit, null);
  });
});

describe("aggregateFromJSONL", () => {
  let tmpBase: string;

  // Build a fake ~/.claude/projects tree with a couple of JSONL lines.
  before(async () => {
    const root = await mkdtemp(join(tmpdir(), "ctm-test-"));
    tmpBase = join(root, "projects");
    const projA = join(tmpBase, "-Users-ethan-Documents-projA");
    const projB = join(tmpBase, "-Users-ethan-Downloads-projB");
    await mkdir(projA, { recursive: true });
    await mkdir(projB, { recursive: true });

    // All timestamps are recent so they fall inside the 24h window.
    const now = new Date();
    const ts = (offsetMs: number) =>
      new Date(now.getTime() + offsetMs).toISOString();

    const lineA1 = {
      type: "assistant",
      timestamp: ts(-60_000), // 1 min ago
      cwd: "/Users/ethan/Documents/projA",
      message: {
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 1_000,
          output_tokens: 500,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 10_000,
        },
      },
    };
    const lineA2 = {
      type: "assistant",
      timestamp: ts(-120_000),
      cwd: "/Users/ethan/Documents/projA",
      message: {
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 2_000,
          output_tokens: 1_000,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 20_000,
        },
      },
    };
    const lineB1 = {
      type: "assistant",
      timestamp: ts(-180_000),
      cwd: "/Users/ethan/Downloads/projB",
      message: {
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 3_000,
          output_tokens: 500,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    };
    // A user line with no usage — must be ignored.
    const userLine = {
      type: "user",
      timestamp: ts(-60_000),
      cwd: "/Users/ethan/Documents/projA",
      message: { role: "user", content: "hi" },
    };

    await writeFile(
      join(projA, "sess1.jsonl"),
      [lineA1, lineA2, userLine].map((l) => JSON.stringify(l)).join("\n"),
    );
    await writeFile(join(projB, "sess2.jsonl"), JSON.stringify(lineB1));
  });

  after(async () => {
    await rm(tmpBase.replace(/\/projects$/, ""), { recursive: true, force: true });
  });

  test("aggregates totals across projects and models", async () => {
    const agg = await aggregateFromJSONL(24, tmpBase);

    assert.equal(agg.totalRequests, 3, "should count only assistant lines");
    assert.equal(agg.totalTokens.input, 1_000 + 2_000 + 3_000);
    assert.equal(agg.totalTokens.output, 500 + 1_000 + 500);
    assert.equal(agg.totalTokens.cacheCreation, 500);
    assert.equal(agg.totalTokens.cacheRead, 10_000 + 20_000);
  });

  test("per-model breakdown contains both models, sorted by cost desc", async () => {
    const agg = await aggregateFromJSONL(24, tmpBase);
    assert.equal(agg.models.length, 2);
    const opus = agg.models.find((m) => m.model === "claude-opus-4-7");
    const sonnet = agg.models.find((m) => m.model === "claude-sonnet-4-6");
    assert.ok(opus, "opus model present");
    assert.ok(sonnet, "sonnet model present");
    assert.equal(opus!.requests, 2);
    assert.equal(sonnet!.requests, 1);
    assert.ok(agg.models[0]!.costUSD >= agg.models[1]!.costUSD, "sorted desc");
  });

  test("total cost equals sum of per-model costs", async () => {
    const agg = await aggregateFromJSONL(24, tmpBase);
    const sum = agg.models.reduce((s, m) => s + m.costUSD, 0);
    assert.ok(Math.abs(agg.totalCostUSD - sum) < 1e-9);
  });

  test("topProjects includes both projects with friendly names", async () => {
    const agg = await aggregateFromJSONL(24, tmpBase);
    assert.equal(agg.topProjects.length, 2);
    const names = agg.topProjects.map((p) => p.name).sort();
    assert.deepEqual(names, ["Documents/projA", "Downloads/projB"]);
  });

  test("topProjects[0] is the most expensive and has correct request count", async () => {
    const agg = await aggregateFromJSONL(24, tmpBase);
    const top = agg.topProjects[0]!;
    assert.equal(top.name, "Documents/projA");
    assert.equal(top.requests, 2);
    assert.ok(top.costUSD > agg.topProjects[1]!.costUSD);
  });

  test("window session tokens = sum of billable (excludes cache_read)", async () => {
    // Cache reads balloon session token counts into hundreds of millions on a
    // long Claude Code run but are effectively discounted by ~10× — excluding
    // them from windowUsed keeps the number aligned with what subscription
    // users see on claude.ai.
    const agg = await aggregateFromJSONL(24, tmpBase);
    const expected =
      agg.totalTokens.input + agg.totalTokens.output + agg.totalTokens.cacheCreation;
    assert.equal(agg.session.windowUsed, expected);
  });

  test("hourlyUsageUSD has 24 slots and sums to today's cost", async () => {
    const agg = await aggregateFromJSONL(24, tmpBase);
    assert.equal(agg.hourlyUsageUSD.length, 24);
    const sum = agg.hourlyUsageUSD.reduce((s, v) => s + v, 0);
    // All our test events are <4 min old so they're in today's bucket.
    assert.ok(Math.abs(sum - agg.totalCostUSD) < 1e-9);
  });

  test("missing projects directory returns an empty aggregate", async () => {
    const agg = await aggregateFromJSONL(24, "/nonexistent/path/xyz");
    assert.equal(agg.totalRequests, 0);
    assert.equal(agg.totalCostUSD, 0);
    assert.deepEqual(agg.topProjects, []);
  });
});
