import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { priceFor } from "./pricing.js";
import { readCloudConfig } from "./cloudConfig.js";
function todayUTCBoundaries() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const d = now.getUTCDate();
    const start = Date.UTC(y, m, d);
    const end = start + 24 * 3600_000;
    const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return { start, end, key };
}
/**
 * Aggregate today's Claude Code usage, strictly bounded by the UTC day so
 * the cloud row for `dateKey` is deterministic across multiple posts.
 */
export async function aggregateUTCDay(basePath) {
    const base = basePath ?? join(homedir(), ".claude", "projects");
    const { start, end, key } = todayUTCBoundaries();
    let projects;
    try {
        projects = await readdir(base);
    }
    catch {
        return empty(key);
    }
    const perModel = new Map();
    let requests = 0;
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
            // Skip files older than yesterday's UTC start — today's data can't be in them.
            if (mtime < start - 24 * 3600_000)
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
                if (Number.isNaN(ts) || ts < start || ts >= end)
                    continue;
                const usage = parsed.message?.usage;
                if (!usage)
                    continue;
                const model = parsed.message?.model || "unknown";
                const entry = perModel.get(model) ??
                    { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, requests: 0 };
                entry.input += usage.input_tokens ?? 0;
                entry.output += usage.output_tokens ?? 0;
                entry.cacheCreation += usage.cache_creation_input_tokens ?? 0;
                entry.cacheRead += usage.cache_read_input_tokens ?? 0;
                entry.requests += 1;
                perModel.set(model, entry);
                requests += 1;
            }
        }
    }
    let costUSD = 0;
    let tokens = 0;
    let cacheSavingsUSD = 0;
    let top = null;
    for (const [model, e] of perModel) {
        const p = priceFor(model);
        const mcost = (e.input * p.input) / 1_000_000 +
            (e.output * p.output) / 1_000_000 +
            (e.cacheCreation * p.cacheWrite) / 1_000_000 +
            (e.cacheRead * p.cacheRead) / 1_000_000;
        const msavings = (e.cacheRead * (p.input - p.cacheRead)) / 1_000_000;
        costUSD += mcost;
        cacheSavingsUSD += msavings;
        tokens += e.input + e.output + e.cacheCreation + e.cacheRead;
        if (!top || mcost > top.cost)
            top = { model, cost: mcost };
    }
    return {
        dateKey: key,
        costUSD: round(costUSD, 4),
        tokens,
        requests,
        cacheSavingsUSD: round(cacheSavingsUSD, 4),
        topModel: top?.model ?? null,
    };
}
function round(v, decimals) {
    const m = 10 ** decimals;
    return Math.round(v * m) / m;
}
function empty(dateKey) {
    return {
        dateKey,
        costUSD: 0,
        tokens: 0,
        requests: 0,
        cacheSavingsUSD: 0,
        topModel: null,
    };
}
export async function postToCloud(agg) {
    const cfg = readCloudConfig();
    if (!cfg)
        return null;
    const url = `${cfg.apiUrl.replace(/\/$/, "")}/api/ingest`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${cfg.token}`,
            },
            body: JSON.stringify(agg),
        });
        const body = await res.json().catch(() => null);
        return { ok: res.ok, status: res.status, body };
    }
    catch (e) {
        return { ok: false, status: 0, body: { error: e.message } };
    }
}
/**
 * Start the periodic cloud poster. Posts immediately on start, then every
 * `intervalMs`. Returns a cleanup function.
 */
export function startCloudPoster(intervalMs = 5 * 60_000) {
    const cfg = readCloudConfig();
    if (!cfg) {
        console.log("[cloud] not connected — run `claudex connect --token <TOKEN>` to enable the public leaderboard.");
        return () => { };
    }
    console.log(`[cloud] connected as ${cfg.tokenPrefix}… → ${cfg.apiUrl} · posting every ${intervalMs / 60_000}m`);
    let inFlight = false;
    const tick = async () => {
        if (inFlight)
            return;
        inFlight = true;
        try {
            const agg = await aggregateUTCDay();
            const r = await postToCloud(agg);
            if (r?.ok) {
                console.log(`[cloud] ↑ ${agg.dateKey}: $${agg.costUSD.toFixed(2)} · ${agg.tokens.toLocaleString()} tokens · save $${agg.cacheSavingsUSD.toFixed(2)} · ${agg.topModel ?? "—"}`);
            }
            else if (r) {
                console.warn(`[cloud] post failed (${r.status}):`, r.body);
            }
        }
        catch (e) {
            console.warn("[cloud] tick error:", e.message);
        }
        finally {
            inFlight = false;
        }
    };
    // Fire once on start, then on interval.
    setTimeout(tick, 1500);
    const handle = setInterval(tick, intervalMs);
    return () => clearInterval(handle);
}
//# sourceMappingURL=cloudPoster.js.map