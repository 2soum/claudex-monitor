import { readFileSync } from "node:fs";

export interface ModelRate {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * $/M token rates. Source: claude.com/pricing, checked 2026-04-17.
 * Cache write rate is the 5-minute TTL tier; extended (1h) cache is a
 * separate SKU on Anthropic's side but reuses the same SKU here for now.
 * Override by setting CLAUDE_PRICING_FILE=/path/to/pricing.json with the
 * same shape, or edit this table and rebuild.
 */
const DEFAULT_PRICING: Record<string, ModelRate> = {
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  default: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

function loadPricing(): Record<string, ModelRate> {
  const override = process.env.CLAUDE_PRICING_FILE;
  if (!override) return DEFAULT_PRICING;
  try {
    const raw = readFileSync(override, "utf8");
    const parsed = JSON.parse(raw) as Record<string, ModelRate>;
    console.log(`[pricing] loaded override from ${override} (${Object.keys(parsed).length} models)`);
    return { ...DEFAULT_PRICING, ...parsed };
  } catch (e) {
    console.warn(`[pricing] could not read CLAUDE_PRICING_FILE=${override}, using defaults:`, e);
    return DEFAULT_PRICING;
  }
}

export const MODEL_PRICING = loadPricing();

export function priceFor(model: string): ModelRate {
  const key = Object.keys(MODEL_PRICING).find((k) => k !== "default" && model.includes(k));
  return MODEL_PRICING[key ?? "default"]!;
}
