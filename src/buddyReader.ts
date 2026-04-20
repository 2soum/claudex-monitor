import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BuddyInfo } from "./protocol.js";

/**
 * Claude Code's `/buddy` feature stores a reroll salt + hatch timestamp at
 * ~/.claude/.buddy-reroll.json. The salt seeds deterministic buddy traits.
 * We expose the raw salt so the client can derive matching visual traits
 * without us having to reverse-engineer the binary.
 *
 * Returns null if the file doesn't exist or can't be parsed — the client
 * will fall back to a default Clawd.
 */
export async function readBuddy(basePath?: string): Promise<BuddyInfo | null> {
  const path = basePath ?? join(homedir(), ".claude", ".buddy-reroll.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: { salt?: unknown; timestamp?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed.salt !== "string" || typeof parsed.timestamp !== "number") {
    return null;
  }
  return {
    hasBuddy: true,
    salt: parsed.salt,
    hatchedAt: parsed.timestamp,
  };
}
