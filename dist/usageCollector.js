import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { priceFor } from "./pricing.js";
export function computeCost(model, u) {
    const p = priceFor(model);
    return ((u.input * p.input) / 1_000_000 +
        (u.output * p.output) / 1_000_000 +
        (u.cacheCreation * p.cacheWrite) / 1_000_000 +
        (u.cacheRead * p.cacheRead) / 1_000_000);
}
const emptyBreakdown = () => ({
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
});
/**
 * Walk the Claude Code projects directory and aggregate usage from the last
 * `hours` hours. Fast: each JSONL is append-only, we stat files first and
 * skip any file whose mtime is older than the window.
 *
 * `basePath` defaults to `~/.claude/projects` and is overridable for tests.
 */
export async function aggregateFromJSONL(hours = 24, basePath, 
/**
 * Force the 5h window to start at a specific epoch. Skips the gap-detection
 * heuristic — needed when the user tells us the Anthropic reset boundary
 * directly because their continuous activity doesn't create a visible gap.
 */
windowStartOverrideMs) {
    const base = basePath ?? join(homedir(), ".claude", "projects");
    const cutoff = Date.now() - hours * 3600_000;
    // Week bucket is calendar-day aligned (local midnight) so `weeklyCostUSD[0]`
    // equals the sum of today's `hourlyUsageUSD` — users shouldn't see two
    // "today" numbers that disagree because one is rolling-24h.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTodayMs = startOfToday.getTime();
    const weekCutoff = startOfTodayMs - 6 * 24 * 3600_000;
    // Month-to-date starts at the 1st of the current local month, 00:00.
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const startOfMonthMs = startOfMonth.getTime();
    // Scan files modified since the earliest relevant cutoff so we don't miss
    // month-old sessions that still overlap the current month.
    const fileScanCutoff = Math.min(weekCutoff, startOfMonthMs);
    let projects;
    try {
        projects = await readdir(base);
    }
    catch {
        return emptyAggregated();
    }
    const perModel = new Map();
    const perProject = new Map();
    const total = emptyBreakdown();
    let totalRequests = 0;
    // 7 calendar days of cost, index 0 = today (local), index 6 = 6 days ago.
    const weeklyCostUSD = new Array(7).fill(0);
    // Hourly usage today (local time), index 0 = 00h
    const hourlyUsageUSD = new Array(24).fill(0);
    // Month-to-date API-equivalent cost
    let monthlyCostUSD = 0;
    // Session window: Claude Code's 5h window starts at the FIRST user action
    // of a fresh session — where "fresh" means preceded by a ≥5h gap of
    // inactivity. We can't read Anthropic's rate-limit headers (they don't
    // land in the JSONL), so we reconstruct the session boundary ourselves.
    //
    // We collect timestamps of any user/assistant turn (not just ones with a
    // `usage` block — user prompts don't carry usage but they DO start the
    // window) in the last ~10h, then walk newest→oldest looking for a ≥5h
    // silence. The start of the run after that silence is our windowStart.
    // This matches what Claude Code's dashboard shows far better than using
    // "earliest assistant reply in last 5h", which was systematically late
    // when an opening turn took several minutes of thinking to respond.
    const windowMs = 5 * 3600_000;
    const sessionScanMs = 10 * 3600_000;
    const sessionTimestamps = [];
    // Real user prompts (excluding tool_result synthetic lines). Anthropic
    // subscription limits are counted as message volume — the iOS client
    // divides this by its plan-specific message budget for the percent gauge.
    const userMessageTimestamps = [];
    // Candidate usage entries for the 5h window tally. We can't sum during the
    // scan because windowStart is only known after the full pass (it depends on
    // gap detection across all timestamps). Store recent entries and filter at
    // the end.
    const windowCandidates = [];
    let windowStart = Date.now();
    const session = {
        windowStart: new Date(windowStart).toISOString(),
        windowResetAt: new Date(windowStart + windowMs).toISOString(),
        windowLimit: null,
        windowUsed: 0,
        windowPercent: 0,
        windowMessages: 0,
    };
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
            if (mtime < fileScanCutoff)
                continue; // skip ancient files entirely
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
                const usage = parsed.message?.usage;
                const model = parsed.message?.model ?? "unknown";
                const ts = parsed.timestamp ? Date.parse(parsed.timestamp) : mtime;
                if (Number.isNaN(ts))
                    continue;
                // Session-window timestamp collection: any user or assistant turn
                // counts as "activity" for session-boundary detection, even if the
                // entry has no `usage` (user prompts, tool results, etc.).
                const kind = parsed.type;
                if ((kind === "user" || kind === "assistant") && ts >= Date.now() - sessionScanMs) {
                    sessionTimestamps.push(ts);
                }
                // Real user prompts only — exclude tool_result synthetic turns which
                // Claude Code writes back with type="user" but role+content indicate
                // a tool response, not an actual prompt from the human.
                if (kind === "user" && ts >= Date.now() - sessionScanMs) {
                    const content = parsed.message?.content;
                    let isRealPrompt = true;
                    if (Array.isArray(content)) {
                        const allToolResult = content.every((c) => typeof c === "object" &&
                            c !== null &&
                            c.type === "tool_result");
                        if (allToolResult)
                            isRealPrompt = false;
                    }
                    if (isRealPrompt)
                        userMessageTimestamps.push(ts);
                }
                if (!usage)
                    continue;
                const breakdown = {
                    input: usage.input_tokens ?? 0,
                    output: usage.output_tokens ?? 0,
                    cacheCreation: usage.cache_creation_input_tokens ?? 0,
                    cacheRead: usage.cache_read_input_tokens ?? 0,
                };
                const cost = computeCost(model, breakdown);
                const tokenSum = breakdown.input + breakdown.output + breakdown.cacheCreation + breakdown.cacheRead;
                // Weekly bucket — calendar-day aligned on local midnight. `daysAgo=0`
                // is strictly "today" (from 00:00 local), so weeklyCostUSD[0] matches
                // hourlyUsageUSD's total.
                if (ts >= weekCutoff) {
                    const daysAgo = daysAgoLocal(ts, startOfTodayMs);
                    if (daysAgo >= 0 && daysAgo < 7) {
                        weeklyCostUSD[daysAgo] += cost;
                    }
                }
                // Hourly bucket for today
                if (ts >= startOfTodayMs) {
                    const hour = new Date(ts).getHours();
                    hourlyUsageUSD[hour] += cost;
                }
                // Month-to-date
                if (ts >= startOfMonthMs) {
                    monthlyCostUSD += cost;
                }
                // 24h window
                if (ts < cutoff)
                    continue;
                total.input += breakdown.input;
                total.output += breakdown.output;
                total.cacheCreation += breakdown.cacheCreation;
                total.cacheRead += breakdown.cacheRead;
                totalRequests += 1;
                const entry = perModel.get(model) ?? { tokens: emptyBreakdown(), requests: 0 };
                entry.tokens.input += breakdown.input;
                entry.tokens.output += breakdown.output;
                entry.tokens.cacheCreation += breakdown.cacheCreation;
                entry.tokens.cacheRead += breakdown.cacheRead;
                entry.requests += 1;
                perModel.set(model, entry);
                // Per-project aggregation, keyed by cwd (falls back to the projects/
                // directory name if cwd is absent — rare, happens for headless runs).
                const projectKey = parsed.cwd || proj;
                const projEntry = perProject.get(projectKey) ?? { costUSD: 0, requests: 0, tokens: 0 };
                projEntry.costUSD += cost;
                projEntry.requests += 1;
                projEntry.tokens += tokenSum;
                perProject.set(projectKey, projEntry);
                // 5h session window — stash candidates; we tally after windowStart
                // is reconstructed so we don't count tokens from before a gap-reset.
                // `billable` excludes cache_read: Anthropic's 5h limit is heavily
                // weighted toward non-cached tokens, and cache reads balloon the
                // raw total into hundreds of millions on long Claude Code sessions,
                // which doesn't reflect what the user sees in the web UI.
                if (ts >= Date.now() - windowMs) {
                    const billable = breakdown.input + breakdown.output + breakdown.cacheCreation;
                    windowCandidates.push({ ts, billable, total: tokenSum });
                }
            }
        }
    }
    // Reconstruct windowStart from session timestamps. Algorithm:
    //   1. Sort asc.
    //   2. Walk newest→oldest, find the most recent ≥5h gap between entries.
    //   3. windowStart = first entry after that gap (or the oldest entry in
    //      the scan if no such gap — the user's been active throughout).
    //   4. Clamp to at most 5h ago — Anthropic's limiter can't look further.
    sessionTimestamps.sort((a, b) => a - b);
    if (windowStartOverrideMs && windowStartOverrideMs > 0) {
        // Client supplied an explicit window boundary (e.g. Anthropic just reset
        // and the iOS app knows when). Trust it — clamp to now - 5h so overrides
        // older than the physical window still behave sanely.
        const lowerBound = Date.now() - windowMs;
        windowStart = Math.max(windowStartOverrideMs, lowerBound);
    }
    else if (sessionTimestamps.length > 0) {
        // Forward walk. Anthropic's 5h window resets on any of:
        //   - ≥5h silence between consecutive messages (previous window expired
        //     entirely), OR
        //   - 5h elapsed since the current session started (natural rollover
        //     from a long continuous work session), OR
        //   - ≥1h of inactivity within an active session. Observed empirically:
        //     claude.ai treats a long-enough pause as a session boundary and
        //     starts a fresh 5h window on resume. 1h is the shortest "long
        //     enough" pause that matches the web-UI behaviour without firing
        //     on ordinary bathroom/meeting breaks.
        const idleResetMs = 60 * 60_000;
        let cursor = sessionTimestamps[0];
        for (let i = 1; i < sessionTimestamps.length; i++) {
            const ts = sessionTimestamps[i];
            const prev = sessionTimestamps[i - 1];
            if (ts - prev >= idleResetMs || ts - cursor >= windowMs) {
                cursor = ts;
            }
        }
        // If `cursor + 5h` is already in the past AND no activity has happened
        // since, the window physically expired during an idle stretch — next
        // message starts a fresh one. Treat the current view as "empty window"
        // so the UI doesn't show phantom usage from the previous session.
        const lastTs = sessionTimestamps[sessionTimestamps.length - 1];
        const windowEnd = cursor + windowMs;
        if (windowEnd < Date.now() && lastTs < windowEnd) {
            windowStart = Date.now();
        }
        else {
            windowStart = cursor;
        }
    }
    session.windowStart = new Date(windowStart).toISOString();
    session.windowResetAt = new Date(windowStart + windowMs).toISOString();
    // Tally windowUsed now that windowStart is known — only count entries
    // after the reconstructed session boundary.
    for (const c of windowCandidates) {
        if (c.ts >= windowStart)
            session.windowUsed += c.billable;
    }
    // Count real user messages in the current 5h window.
    for (const ts of userMessageTimestamps) {
        if (ts >= windowStart)
            session.windowMessages += 1;
    }
    const models = [...perModel.entries()]
        .map(([model, v]) => ({
        model,
        tokens: v.tokens,
        requests: v.requests,
        costUSD: computeCost(model, v.tokens),
    }))
        .sort((a, b) => b.costUSD - a.costUSD);
    const totalCostUSD = models.reduce((s, m) => s + m.costUSD, 0);
    const topProjects = [...perProject.entries()]
        .map(([path, v]) => ({
        name: friendlyProjectName(path),
        path,
        costUSD: v.costUSD,
        requests: v.requests,
        tokens: v.tokens,
    }))
        .sort((a, b) => b.costUSD - a.costUSD)
        .slice(0, 5);
    return {
        totalTokens: total,
        totalCostUSD,
        totalRequests,
        models,
        session,
        weeklyCostUSD,
        topProjects,
        hourlyUsageUSD,
        monthlyCostUSD,
        monthStartEpoch: startOfMonthMs,
    };
}
/** Number of local-midnight boundaries between `ts` and today. 0 = today. */
function daysAgoLocal(ts, startOfTodayMs) {
    if (ts >= startOfTodayMs)
        return 0;
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return Math.round((startOfTodayMs - d.getTime()) / (24 * 3600_000));
}
/** `/Users/foo/Documents/my-app/server` → `my-app/server` */
export function friendlyProjectName(path) {
    const segs = path.split("/").filter(Boolean);
    if (segs.length === 0)
        return path;
    if (segs.length === 1)
        return segs[0];
    return segs.slice(-2).join("/");
}
function emptyAggregated() {
    const now = Date.now();
    const mStart = new Date();
    mStart.setDate(1);
    mStart.setHours(0, 0, 0, 0);
    return {
        totalTokens: emptyBreakdown(),
        totalCostUSD: 0,
        totalRequests: 0,
        models: [],
        session: {
            windowStart: new Date(now).toISOString(),
            windowResetAt: new Date(now + 5 * 3600_000).toISOString(),
            windowLimit: null,
            windowUsed: 0,
            windowPercent: 0,
            windowMessages: 0,
        },
        weeklyCostUSD: new Array(7).fill(0),
        topProjects: [],
        hourlyUsageUSD: new Array(24).fill(0),
        monthlyCostUSD: 0,
        monthStartEpoch: mStart.getTime(),
    };
}
/**
 * Best-effort: runs `claude --print '/usage'` to extract plan limits.
 * If the CLI isn't installed or the command fails, returns null and we fall back to JSONL-only.
 */
export function runUsageSlashCommand(timeoutMs = 8000) {
    return new Promise((resolve) => {
        const child = spawn("claude", ["--print", "/usage"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            resolve(null);
        }, timeoutMs);
        child.stdout.on("data", (d) => (out += d.toString()));
        child.on("error", () => {
            clearTimeout(timer);
            resolve(null);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve(code === 0 ? out : null);
        });
    });
}
/** Parse the human-readable /usage output to extract plan window limit. */
export function parseUsageOutput(text) {
    // Looks for lines like "Current 5-hour usage: 23%" and "Session tokens: 145,231 / 500,000"
    const pctMatch = text.match(/(\d+(?:\.\d+)?)\s*%/);
    const limitMatch = text.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
    return {
        windowLimit: limitMatch ? Number(limitMatch[2].replace(/,/g, "")) : null,
        windowPercent: pctMatch ? Number(pctMatch[1]) : null,
    };
}
//# sourceMappingURL=usageCollector.js.map