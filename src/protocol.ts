/**
 * Wire protocol shared between Mac server and iPad client.
 * Keep in sync with ios-app/Models/TokenSnapshot.swift
 */

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface ModelUsage {
  model: string; // e.g. "claude-opus-4-7"
  tokens: TokenBreakdown;
  costUSD: number;
  requests: number;
}

export interface RTKGains {
  /** Cache hit ratio (0-1) — cache reads / (cache reads + input tokens we'd otherwise pay full price for) */
  cacheHitRatio: number;
  /** Total tokens saved via prompt caching vs. uncached equivalent */
  tokensSavedCache: number;
  /** USD saved via prompt caching */
  costSavedCache: number;
}

/**
 * Summary of `rtk gain -f json` — token savings from shell-command rewriting.
 * Orthogonal to `RTKGains` (which is about prompt caching). Null if the
 * `rtk` CLI is not installed on this Mac.
 */
export interface RtkCliStats {
  totalCommands: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSavedTokens: number;
  avgSavingsPct: number; // 0–100
  totalTimeMs: number;
  avgTimeMs: number;
  /** Estimated $ saved — tokens saved × input rate of the user's top 24h model. */
  estimatedSavingsUSD: number;
  /** The model whose input rate we used for the estimate (for UI transparency). */
  estimatedAgainstModel: string;
}

export interface SessionInfo {
  /** Current 5h window, ISO8601 */
  windowStart: string;
  /** When the 5h window resets, ISO8601 */
  windowResetAt: string;
  /** Plan limit tokens in window if known */
  windowLimit: number | null;
  /** Tokens used in current window */
  windowUsed: number;
  /** Percentage used (0-100) */
  windowPercent: number;
  /**
   * Count of real user prompts (excluding synthetic tool_result turns) in the
   * current 5h window. claude.ai counts message volume, not tokens, for
   * subscription limits — the iOS client divides this by the plan-specific
   * message limit to render the percent gauge.
   */
  windowMessages: number;
}

export interface TopProject {
  /** Friendly project name (last path segment of cwd) */
  name: string;
  /** Full cwd path */
  path: string;
  costUSD: number;
  requests: number;
  tokens: number;
}

export interface BuddyInfo {
  /** True when ~/.claude/.buddy-reroll.json is present, i.e. user ran /buddy. */
  hasBuddy: boolean;
  /** Reroll salt from the file — used client-side to derive visual traits deterministically. */
  salt: string;
  /** ms since epoch when the current buddy was hatched (reroll timestamp). */
  hatchedAt: number;
}

export interface TokenSnapshot {
  /** ms since epoch of snapshot */
  timestamp: number;
  /** Across all models, last 24h */
  totalTokens: TokenBreakdown;
  totalCostUSD: number;
  totalRequests: number;
  /** Per-model breakdown */
  models: ModelUsage[];
  /** Current 5h rolling window stats */
  session: SessionInfo;
  /** Cache-read savings */
  rtk: RTKGains;
  /** Cost for last 7 days per day, index 0 = today */
  weeklyCostUSD: number[];
  /** Tokens per minute, sampled over last N intervals for sparkline */
  tpmSeries: number[];
  /** Minutes until the 5h window hits 100% at the current TPM, null if TPM==0 or no limit */
  projectionMinutesToLimit: number | null;
  /** Top 5 projects (by cost) in the last 24h */
  topProjects: TopProject[];
  /** Cost per hour today (index 0 = 00h), in local time */
  hourlyUsageUSD: number[];
  /** Optional rtk CLI (shell-rewriting) lifetime stats — null if rtk isn't installed. */
  rtkCliStats: RtkCliStats | null;
  /** Optional /buddy companion state, null if user has never run /buddy. */
  buddy: BuddyInfo | null;
  /** API-equivalent cost since the 1st of the current local calendar month. */
  monthlyCostUSD: number;
  /** ms since epoch of the 1st of the current local calendar month (00:00). */
  monthStartEpoch: number;
}

export type ServerMessage =
  | { type: "snapshot"; data: TokenSnapshot }
  | { type: "hello"; data: { serverVersion: string; hostname: string } }
  | { type: "error"; data: { message: string } };

export type ClientMessage =
  | { type: "subscribe" }
  | { type: "refresh" }
  | { type: "ping" }
  /**
   * Pin the 5h window's start. Needed because server-side gap-detection
   * can't spot Anthropic's fixed reset boundary while the user is
   * continuously active — the JSONL has no silence to mark the cutover.
   * `epochMs = 0` clears the override.
   */
  | { type: "setWindowStart"; data: { epochMs: number } };
