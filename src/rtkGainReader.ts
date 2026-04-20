import { spawn } from "node:child_process";

/**
 * Summary of `rtk gain -f json`. RTK is the Rust Token Killer CLI — it
 * rewrites shell tool outputs to save tokens before they're sent to Claude.
 * Completely orthogonal to prompt caching.
 *
 * Returns null when `rtk` isn't installed, errors out, or returns an
 * unrecognized shape — callers treat null as "no data".
 */
export interface RtkGainSummary {
  totalCommands: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSavedTokens: number;
  avgSavingsPct: number; // 0–100
  totalTimeMs: number;
  avgTimeMs: number;
}

interface RawSummary {
  total_commands?: number;
  total_input?: number;
  total_output?: number;
  total_saved?: number;
  avg_savings_pct?: number;
  total_time_ms?: number;
  avg_time_ms?: number;
}

export function readRtkGain(timeoutMs = 3000): Promise<RtkGainSummary | null> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (val: RtkGainSummary | null) => {
      if (finished) return;
      finished = true;
      resolve(val);
    };

    const child = spawn("rtk", ["gain", "-f", "json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !out) return finish(null);
      try {
        const parsed = JSON.parse(out) as { summary?: RawSummary };
        const s = parsed.summary;
        if (!s || typeof s.total_commands !== "number") return finish(null);
        finish({
          totalCommands: s.total_commands ?? 0,
          totalInputTokens: s.total_input ?? 0,
          totalOutputTokens: s.total_output ?? 0,
          totalSavedTokens: s.total_saved ?? 0,
          avgSavingsPct: s.avg_savings_pct ?? 0,
          totalTimeMs: s.total_time_ms ?? 0,
          avgTimeMs: s.avg_time_ms ?? 0,
        });
      } catch {
        finish(null);
      }
    });
  });
}
