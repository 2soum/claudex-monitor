import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readPkg(): { version?: string } {
  // dist/version.js sits next to package.json's bin target, so ../package.json
  // resolves to the repo root whether we run from dist/ or src/ (tsx).
  const candidates = [
    join(__dirname, "..", "package.json"),
    join(__dirname, "..", "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* try next */
    }
  }
  return {};
}

export const MONITOR_VERSION = readPkg().version || "0.0.0";

function parse(v: string): [number, number, number] {
  const p = v.split(".").map((x) => Number(x) || 0);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
}

export function compare(a: string, b: string): number {
  const [ma, mi, pa] = parse(a);
  const [mb, mi2, pb] = parse(b);
  if (ma !== mb) return ma - mb;
  if (mi !== mi2) return mi - mi2;
  return pa - pb;
}

export interface UpdateInfo {
  available: boolean;
  latest: string;
  changelog: string[];
  installCommand: string;
}

export async function checkForUpdate(apiUrl: string): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/api/monitor/version`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      latest?: string;
      changelog?: Record<string, string[]>;
      installCommands?: { unix?: string; windows?: string };
    };
    if (!data.latest) return null;
    const available = compare(MONITOR_VERSION, data.latest) < 0;
    const isWin = process.platform === "win32";
    return {
      available,
      latest: data.latest,
      changelog: data.changelog?.[data.latest] || [],
      installCommand:
        (isWin ? data.installCommands?.windows : data.installCommands?.unix) ||
        "",
    };
  } catch {
    return null;
  }
}
