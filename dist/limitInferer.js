import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const WINDOW_MS = 5 * 3600_000;
const SCAN_DAYS = 90;
const RATE_LIMIT_BUFFER = 1.05;
export async function inferWindowLimit(basePath) {
    const base = basePath ?? join(homedir(), ".claude", "projects");
    const cutoff = Date.now() - SCAN_DAYS * 24 * 3600_000;
    let projects;
    try {
        projects = await readdir(base);
    }
    catch {
        return null;
    }
    const billable = [];
    const rateLimitTs = [];
    for (const proj of projects) {
        const projDir = join(base, proj);
        let files;
        try {
            files = await readdir(projDir);
        }
        catch {
            continue;
        }
        for (const f of files) {
            if (!f.endsWith(".jsonl"))
                continue;
            const fp = join(projDir, f);
            let mtime;
            try {
                mtime = (await stat(fp)).mtimeMs;
            }
            catch {
                continue;
            }
            if (mtime < cutoff)
                continue;
            let content;
            try {
                content = await readFile(fp, "utf8");
            }
            catch {
                continue;
            }
            for (const line of content.split("\n")) {
                if (!line)
                    continue;
                let parsed;
                try {
                    parsed = JSON.parse(line);
                }
                catch {
                    continue;
                }
                const ts = parsed.timestamp ? Date.parse(parsed.timestamp) : mtime;
                if (Number.isNaN(ts))
                    continue;
                if (parsed.isApiErrorMessage && parsed.error === "rate_limit") {
                    rateLimitTs.push(ts);
                    continue;
                }
                const u = parsed.message?.usage;
                if (!u)
                    continue;
                const sum = (u.input_tokens ?? 0) +
                    (u.output_tokens ?? 0) +
                    (u.cache_creation_input_tokens ?? 0);
                if (sum > 0)
                    billable.push({ ts, billable: sum });
            }
        }
    }
    if (billable.length === 0)
        return null;
    billable.sort((a, b) => a.ts - b.ts);
    // 1. Rate-limit-inferred: max preceding-5h sum across all 429 events.
    let rlInferred = 0;
    for (const rlTs of rateLimitTs) {
        let sum = 0;
        for (const e of billable) {
            if (e.ts >= rlTs)
                break;
            if (e.ts >= rlTs - WINDOW_MS)
                sum += e.billable;
        }
        if (sum > rlInferred)
            rlInferred = sum;
    }
    // 2. Peak rolling 5h sum. Sliding-window over sorted entries.
    let peak = 0;
    let windowSum = 0;
    let windowStart = 0;
    for (let i = 0; i < billable.length; i++) {
        windowSum += billable[i].billable;
        while (billable[windowStart].ts < billable[i].ts - WINDOW_MS) {
            windowSum -= billable[windowStart].billable;
            windowStart++;
        }
        if (windowSum > peak)
            peak = windowSum;
    }
    const rlEstimate = Math.round(rlInferred * RATE_LIMIT_BUFFER);
    const best = Math.max(rlEstimate, peak);
    return best > 0 ? best : null;
}
//# sourceMappingURL=limitInferer.js.map