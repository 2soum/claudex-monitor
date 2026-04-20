import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Infer the 5-hour window token limit from Claude Code's JSONL history.
 *
 * Anthropic adjusts 5h limits internally per-user based on usage patterns,
 * so there's no published table we can match. We derive the limit from two
 * observable signals — both strict lower bounds, combined by taking the max:
 *
 *  1. **Peak 5h rolling billable sum without a 429.** If the user sustained
 *     N tokens over any 5h window and did *not* hit the rate limit, the
 *     current limit is ≥ N. No buffer applied — an observed ceiling IS the
 *     floor of the real limit.
 *
 *  2. **Rate-limit events.** When Anthropic returns 429, Claude Code writes
 *     a synthetic assistant line with `error: "rate_limit"`. Summing billable
 *     tokens over the preceding 5h gives the exact point the user crossed
 *     on that day's plan. A tiny ×1.05 buffer covers the cost of the
 *     would-be-next request that triggered the 429.
 *
 * On plan upgrades the peak naturally grows past old rate-limit marks, so
 * the estimate self-adjusts over time. Calling this periodically (every
 * ~1h) keeps us current with Anthropic's internal tweaks.
 */

interface Entry { ts: number; billable: number; }

const WINDOW_MS = 5 * 3600_000;
const SCAN_DAYS = 90;
const RATE_LIMIT_BUFFER = 1.05;

interface RawLine {
  timestamp?: string;
  error?: string;
  isApiErrorMessage?: boolean;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

export async function inferWindowLimit(basePath?: string): Promise<number | null> {
  const base = basePath ?? join(homedir(), ".claude", "projects");
  const cutoff = Date.now() - SCAN_DAYS * 24 * 3600_000;

  let projects: string[];
  try {
    projects = await readdir(base);
  } catch {
    return null;
  }

  const billable: Entry[] = [];
  const rateLimitTs: number[] = [];

  for (const proj of projects) {
    const projDir = join(base, proj);
    let files: string[];
    try {
      files = await readdir(projDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = join(projDir, f);
      let mtime: number;
      try {
        mtime = (await stat(fp)).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < cutoff) continue;

      let content: string;
      try {
        content = await readFile(fp, "utf8");
      } catch {
        continue;
      }

      for (const line of content.split("\n")) {
        if (!line) continue;
        let parsed: RawLine;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = parsed.timestamp ? Date.parse(parsed.timestamp) : mtime;
        if (Number.isNaN(ts)) continue;

        if (parsed.isApiErrorMessage && parsed.error === "rate_limit") {
          rateLimitTs.push(ts);
          continue;
        }

        const u = parsed.message?.usage;
        if (!u) continue;
        const sum =
          (u.input_tokens ?? 0) +
          (u.output_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0);
        if (sum > 0) billable.push({ ts, billable: sum });
      }
    }
  }

  if (billable.length === 0) return null;

  billable.sort((a, b) => a.ts - b.ts);

  // 1. Rate-limit-inferred: max preceding-5h sum across all 429 events.
  let rlInferred = 0;
  for (const rlTs of rateLimitTs) {
    let sum = 0;
    for (const e of billable) {
      if (e.ts >= rlTs) break;
      if (e.ts >= rlTs - WINDOW_MS) sum += e.billable;
    }
    if (sum > rlInferred) rlInferred = sum;
  }

  // 2. Peak rolling 5h sum. Sliding-window over sorted entries.
  let peak = 0;
  let windowSum = 0;
  let windowStart = 0;
  for (let i = 0; i < billable.length; i++) {
    windowSum += billable[i]!.billable;
    while (billable[windowStart]!.ts < billable[i]!.ts - WINDOW_MS) {
      windowSum -= billable[windowStart]!.billable;
      windowStart++;
    }
    if (windowSum > peak) peak = windowSum;
  }

  const rlEstimate = Math.round(rlInferred * RATE_LIMIT_BUFFER);
  const best = Math.max(rlEstimate, peak);
  return best > 0 ? best : null;
}
