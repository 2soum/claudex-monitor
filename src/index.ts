import { WebSocketServer, WebSocket } from "ws";
import { Bonjour } from "bonjour-service";
import { hostname } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { watch } from "chokidar";
import {
  aggregateFromJSONL,
  runUsageSlashCommand,
  parseUsageOutput,
} from "./usageCollector.js";
import { computeRTKGains } from "./rtkTracker.js";
import { readBuddy } from "./buddyReader.js";
import { readRtkGain } from "./rtkGainReader.js";
import { inferWindowLimit } from "./limitInferer.js";
import { priceFor } from "./pricing.js";
import { startCloudPoster } from "./cloudPoster.js";
import { checkForUpdate, MONITOR_VERSION } from "./version.js";
import { readCloudConfig } from "./cloudConfig.js";
import { spawnInstaller, RESTART_EXIT_CODE } from "./updater.js";
import type { ServerMessage, ClientMessage, TokenSnapshot } from "./protocol.js";

const AUTO_UPDATE = process.argv.includes("--auto-update");

const PORT = Number(process.env.PORT ?? 7337);
const SERVICE_NAME = "Claude Token Monitor";
const SERVICE_TYPE = "claude-tokens"; // advertised as _claude-tokens._tcp.local
const VERSION = "1.0.0";

// Rolling tokens-per-minute series. Each sample is the billable-token delta
// between two consecutive 5s ticks, so *12 = tokens/minute. Kept decoupled
// from buildSnapshot so file-watcher-triggered rebuilds don't pollute the
// series with sub-5s samples that would all look like "5s worth" downstream.
const TPM_WINDOW = 60;
const TPM_INTERVAL_MS = 5000;
const tpmSeries: number[] = [];
let lastBillableTotal = 0;
let tpmInitialized = false;

// Optional token-based plan limit override — pins the denominator manually
// when you want to bypass auto-inference. Auto-inference is robust enough
// for most users, so leave this unset unless the inferred value is clearly
// off.
const WINDOW_LIMIT_OVERRIDE: number | null =
  process.env.CLAUDE_WINDOW_LIMIT ? Number(process.env.CLAUDE_WINDOW_LIMIT) : null;

// Auto-inferred limit from historical rate-limit events + observed peaks.
// Refreshed hourly so Anthropic's internal per-user limit tweaks are picked
// up over time. The scanner reads the last 90 days of JSONL on each refresh.
let inferredWindowLimit: number | null = null;

let lastSnapshot: TokenSnapshot | null = null;
let buildInFlight: Promise<TokenSnapshot> | null = null;

/**
 * Build a fresh snapshot. With no override, the result is cached and reused
 * across broadcasts (the common path). When `windowStartOverride` is set,
 * we re-aggregate fresh every time — it's a per-client view so it bypasses
 * the cache.
 */
async function buildSnapshot(windowStartOverride?: number): Promise<TokenSnapshot> {
  if (windowStartOverride && windowStartOverride > 0) {
    return buildSnapshotFresh(windowStartOverride);
  }
  // De-dupe concurrent builds — the /usage shell-out is expensive
  if (buildInFlight) return buildInFlight;
  buildInFlight = buildSnapshotFresh(undefined);
  try {
    return await buildInFlight;
  } finally {
    buildInFlight = null;
  }
}

async function buildSnapshotFresh(windowStartOverride?: number): Promise<TokenSnapshot> {
  {
    const [agg, usageText, buddy, rtkCliRaw] = await Promise.all([
      aggregateFromJSONL(24, undefined, windowStartOverride),
      runUsageSlashCommand(),
      readBuddy(),
      readRtkGain(),
    ]);

    // Convert RTK CLI token savings to $ using the input rate of the user's
    // dominant 24h model (fallback: claude-opus-4-7 since RTK users tend to
    // be heavy Opus users). Result is a lower bound if they mix in cheaper
    // models, an upper bound if they're actually on pricier tiers.
    const topModel = agg.models[0]?.model ?? "claude-opus-4-7";
    const topRate = priceFor(topModel).input;
    const rtkCliStats = rtkCliRaw
      ? {
          ...rtkCliRaw,
          estimatedSavingsUSD: (rtkCliRaw.totalSavedTokens * topRate) / 1_000_000,
          estimatedAgainstModel: topModel,
        }
      : null;
    const rtk = computeRTKGains(agg);

    let session = agg.session;
    let authoritativePercent: number | null = null;
    if (usageText) {
      const parsed = parseUsageOutput(usageText);
      if (parsed.windowLimit) session.windowLimit = parsed.windowLimit;
      if (parsed.windowPercent !== null) {
        session.windowPercent = parsed.windowPercent;
        authoritativePercent = parsed.windowPercent;
      }
    }
    // Apply env override only if /usage didn't already provide a limit.
    if (!session.windowLimit && WINDOW_LIMIT_OVERRIDE) {
      session.windowLimit = WINDOW_LIMIT_OVERRIDE;
    }
    // Fallback to auto-inferred limit from historical activity.
    if (!session.windowLimit && inferredWindowLimit) {
      session.windowLimit = inferredWindowLimit;
    }
    // Derive percent from limit only when we don't already have an authoritative one.
    if (authoritativePercent === null && session.windowLimit) {
      session.windowPercent = Math.min(100, (session.windowUsed / session.windowLimit) * 100);
    }

    // Projection — extrapolate time-to-limit from the average of recent
    // non-zero TPM samples (each sample = 5s of billable tokens).
    const recent = tpmSeries.slice(-12).filter((v) => v > 0);
    const tokensPerMinute =
      recent.length > 0 ? (recent.reduce((s, v) => s + v, 0) / recent.length) * 12 : 0;
    const remaining = session.windowLimit ? session.windowLimit - session.windowUsed : 0;
    const projectionMinutesToLimit =
      tokensPerMinute > 0 && remaining > 0 ? remaining / tokensPerMinute : null;

    const snap: TokenSnapshot = {
      timestamp: Date.now(),
      totalTokens: agg.totalTokens,
      totalCostUSD: agg.totalCostUSD,
      totalRequests: agg.totalRequests,
      models: agg.models,
      session,
      rtk,
      weeklyCostUSD: agg.weeklyCostUSD,
      tpmSeries: [...tpmSeries],
      projectionMinutesToLimit,
      topProjects: agg.topProjects,
      hourlyUsageUSD: agg.hourlyUsageUSD,
      rtkCliStats,
      buddy,
      monthlyCostUSD: agg.monthlyCostUSD,
      monthStartEpoch: agg.monthStartEpoch,
    };
    if (!windowStartOverride) lastSnapshot = snap;
    return snap;
  }
}

// ---------- WebSocket server ----------
const wss = new WebSocketServer({ port: PORT });
const clients = new Set<WebSocket>();
/**
 * Clients that have explicitly subscribed — i.e. sent their config
 * (including any windowStart override) and are ready to receive snapshots.
 * Broadcasts skip un-subscribed clients so a freshly-connected iOS app
 * doesn't momentarily receive an un-overridden snapshot from a file-watcher
 * fire that races its own subscribe message.
 */
const subscribed = new Set<WebSocket>();
/**
 * Per-connection windowStart override (epochMs). Clients that have pinned
 * the Anthropic reset boundary via their UI send this so their snapshot
 * reflects the correct 5h window even while activity is continuous.
 */
const clientOverrides = new Map<WebSocket, number>();

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

async function sendSnapshot(ws: WebSocket) {
  const override = clientOverrides.get(ws);
  const snap = override ? await buildSnapshot(override) : lastSnapshot ?? (await buildSnapshot());
  send(ws, { type: "snapshot", data: snap });
}

async function broadcastSnapshot() {
  // Clients without an override share the global cached snapshot; clients
  // with one get a per-request re-aggregation. Worst case: per-client work
  // on a file-watcher event, but buildSnapshot() is ~50ms even for heavy
  // histories, so negligible for a personal machine.
  const base = await buildSnapshot();
  for (const ws of subscribed) {
    if (ws.readyState !== ws.OPEN) continue;
    const override = clientOverrides.get(ws);
    if (override) {
      const custom = await buildSnapshot(override);
      send(ws, { type: "snapshot", data: custom });
    } else {
      send(ws, { type: "snapshot", data: base });
    }
  }
}

wss.on("connection", async (ws, req) => {
  clients.add(ws);
  const ip = req.socket.remoteAddress;
  console.log(`[ws] client connected from ${ip} (${clients.size} total)`);

  send(ws, { type: "hello", data: { serverVersion: VERSION, hostname: hostname() } });
  // No automatic snapshot on connect — the client sends `setWindowStart`
  // first (if it has a pinned override) then `subscribe`. Waiting for the
  // explicit subscribe avoids a race where we flash an un-overridden
  // percent at cold start, which then gets multiplied by the iOS
  // calibration factor and pegs the gauge at 100% for a split second.

  ws.on("message", async (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "subscribe" || msg.type === "refresh") {
      subscribed.add(ws);
      await sendSnapshot(ws);
    } else if (msg.type === "setWindowStart") {
      // 0 clears the override; otherwise pin and immediately re-send a fresh
      // snapshot so the UI updates instantly rather than waiting for the
      // next broadcast.
      const v = msg.data?.epochMs ?? 0;
      if (v > 0) clientOverrides.set(ws, v);
      else clientOverrides.delete(ws);
      await sendSnapshot(ws);
    } else if (msg.type === "ping") {
      // no-op keepalive
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    subscribed.delete(ws);
    clientOverrides.delete(ws);
    console.log(`[ws] client disconnected (${clients.size} remaining)`);
  });

  ws.on("error", (e) => console.error("[ws] error:", e.message));
});

// ---------- File watcher for near-real-time updates ----------
const watchPath = join(homedir(), ".claude", "projects");
let rebuildTimer: NodeJS.Timeout | null = null;

watch(watchPath, {
  ignoreInitial: true,
  depth: 3,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
}).on("all", (event) => {
  if (event !== "add" && event !== "change") return;
  // Debounce: Claude Code appends frequently during a turn
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    await broadcastSnapshot();
  }, 400);
});

// Dedicated TPM sampler — fires at a strict cadence so each series entry
// represents exactly `TPM_INTERVAL_MS` of billable tokens. Reads from
// `lastSnapshot` (updated by the watcher + periodic rebuild) instead of
// re-aggregating, so we don't double-scan the disk every 5s.
function sampleTPM() {
  const snap = lastSnapshot;
  if (!snap) return; // no snapshot yet — wait for first build
  const billable =
    snap.totalTokens.input + snap.totalTokens.output + snap.totalTokens.cacheCreation;
  if (tpmInitialized) {
    const delta = Math.max(0, billable - lastBillableTotal);
    tpmSeries.push(delta);
    if (tpmSeries.length > TPM_WINDOW) tpmSeries.shift();
  } else {
    tpmInitialized = true;
  }
  lastBillableTotal = billable;
}
setInterval(sampleTPM, TPM_INTERVAL_MS);

// Periodic fallback rebuild in case the file watcher misses events. Every
// 30s is plenty — the watcher catches the vast majority of writes.
setInterval(async () => {
  await broadcastSnapshot();
}, 30_000);

// ---------- Bonjour service advertisement ----------
const bonjour = new Bonjour();
const service = bonjour.publish({
  name: SERVICE_NAME,
  type: SERVICE_TYPE,
  port: PORT,
  txt: { version: VERSION, path: "/ws" },
});
service.start?.();

console.log(`
  Claude Token Monitor — server v${VERSION}${AUTO_UPDATE ? " (auto-update: on)" : ""}
  ───────────────────────────────────────────
  WebSocket:  ws://0.0.0.0:${PORT}
  mDNS:       _${SERVICE_TYPE}._tcp.local.
  Watching:   ${watchPath}
  Hostname:   ${hostname()}
`);

// Refresh the auto-inferred 5h limit on startup and hourly thereafter.
// Anthropic tweaks per-user limits internally; the peak/rate-limit signals
// move over time, and an hourly refresh catches those drifts.
async function refreshLimit() {
  try {
    const inferred = await inferWindowLimit();
    if (inferred && inferred !== inferredWindowLimit) {
      console.log(`[limit] inferred 5h window limit: ${inferred.toLocaleString()} tokens`);
      inferredWindowLimit = inferred;
    } else if (!inferred && !inferredWindowLimit) {
      console.log("[limit] not enough history yet — limit stays unknown");
    }
  } catch (e) {
    console.warn("[limit] inference failed:", (e as Error).message);
  }
}
refreshLimit();
setInterval(refreshLimit, 3600_000);

// ---------- Cloud poster (public leaderboard) ----------
// Fires immediately on start, then every 5 minutes. No-op if `claudex connect`
// hasn't been run yet.
const stopCloudPoster = startCloudPoster(
  Number(process.env.CLAUDEX_POST_INTERVAL_MS ?? 5 * 60_000)
);

// ---------- Check for monitor updates ----------
// Once on boot + every 6h. Prints a banner, or self-installs when
// `--auto-update` was passed. On successful self-install we exit with
// RESTART_EXIT_CODE so a supervisor (systemd / launchd / nssm / while-loop)
// restarts us onto the new code.
let updateInFlight = false;

async function checkUpdate() {
  const cfg = readCloudConfig();
  if (!cfg) return;
  const info = await checkForUpdate(cfg.apiUrl);
  if (!info || !info.available) return;

  console.log(`
  ★ claudex-monitor update available
  ──────────────────────────────────
  running: ${MONITOR_VERSION}
  latest:  ${info.latest}
${info.changelog.map((l) => "    · " + l).join("\n")}`);

  if (!AUTO_UPDATE) {
    console.log(`
  Update:  ${info.installCommand}
  Or pass --auto-update to claudex start for supervised self-update.
`);
    return;
  }

  if (updateInFlight) return;
  updateInFlight = true;
  console.log(`\n  Auto-updating now…\n`);

  const child = spawnInstaller(cfg.apiUrl);
  child.on("exit", (code) => {
    if (code === 0) {
      console.log(`\n✓ updated. Exiting ${RESTART_EXIT_CODE} so your supervisor restarts on new code.\n`);
      try { stopCloudPoster(); } catch { /* ignore */ }
      try { service.stop?.(() => bonjour.destroy()); } catch { /* ignore */ }
      try { wss.close(); } catch { /* ignore */ }
      process.exit(RESTART_EXIT_CODE);
    } else {
      console.error(`\n✗ auto-update failed (exit ${code}). Staying on v${MONITOR_VERSION} — will retry in 6h.\n`);
      updateInFlight = false;
    }
  });
  child.on("error", (e) => {
    console.error(`\n✗ auto-update spawn failed: ${(e as Error).message}`);
    updateInFlight = false;
  });
}
setTimeout(checkUpdate, 3000);
setInterval(checkUpdate, 6 * 3600_000);

// Graceful shutdown so Bonjour unregisters cleanly
async function shutdown() {
  console.log("\n[server] shutting down…");
  stopCloudPoster();
  service.stop?.(() => bonjour.destroy());
  wss.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
