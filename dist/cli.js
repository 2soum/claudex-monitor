import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { readCloudConfig, writeCloudConfig, clearCloudConfig, CONFIG_PATH, DEFAULT_API_URL, } from "./cloudConfig.js";
import { aggregateUTCDay, postToCloud } from "./cloudPoster.js";
import { checkForUpdate, MONITOR_VERSION } from "./version.js";
import { runInstaller } from "./updater.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
function parseArgv(argv) {
    const [, , cmdRaw, ...rest] = argv;
    const cmd = (cmdRaw || "help");
    const flags = {};
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a.startsWith("--")) {
            const k = a.slice(2);
            const next = rest[i + 1];
            if (next && !next.startsWith("--")) {
                flags[k] = next;
                i++;
            }
            else {
                flags[k] = "true";
            }
        }
    }
    return { cmd, flags };
}
function usage() {
    return `Claudex Monitor — CLI v${MONITOR_VERSION}

USAGE
  claudex connect --token <TOKEN> [--api <URL>]   Link this machine to the public scoreboard
  claudex disconnect                              Remove the stored monitor token
  claudex status                                  Show current config + a dry-run aggregate
  claudex once                                    Aggregate today + POST once, then exit
  claudex start [--auto-update]                   Start the full daemon (WebSocket LAN + cloud)
  claudex update                                  Pull + build the latest monitor version
  claudex help                                    Show this message

AUTO-UPDATE (supervisor-friendly)
  claudex start --auto-update
    When a new version is detected, runs the installer inline and exits with
    code ${72} so your supervisor can restart the daemon on new code. Works
    with systemd (RestartForceExitStatus=72), launchd (KeepAlive=true), nssm,
    or a simple loop:
        while :; do claudex start --auto-update; done

CONFIG
  ~/.claudex/config.json            stores the monitor token (0600 perms)
  CLAUDEX_API_URL                   overrides the API URL (default: ${DEFAULT_API_URL})

Get your token on the dashboard:
  ${DEFAULT_API_URL}/app
`;
}
async function cmdConnect(flags) {
    const token = flags.token?.trim();
    const apiUrl = flags.api?.trim() || DEFAULT_API_URL;
    if (!token) {
        console.error("Missing --token <TOKEN>");
        console.error("Get yours at " + apiUrl + "/app");
        return 2;
    }
    if (token.length < 16) {
        console.error("Token looks malformed (too short).");
        return 2;
    }
    writeCloudConfig({
        token,
        apiUrl,
        connectedAt: Date.now(),
        tokenPrefix: token.slice(0, 8),
    });
    console.log(`✓ connected to ${apiUrl}`);
    console.log(`  token prefix: ${token.slice(0, 8)}… (stored ${CONFIG_PATH})`);
    console.log(`  run \`claudex once\` to post your first aggregate.`);
    return 0;
}
function cmdDisconnect() {
    if (!existsSync(CONFIG_PATH)) {
        console.log("Not connected — nothing to do.");
        return 0;
    }
    clearCloudConfig();
    console.log("✓ disconnected. The old token is still valid on the cloud; regenerate from /app to fully rotate.");
    return 0;
}
async function cmdStatus() {
    const cfg = readCloudConfig();
    console.log(`claudex-monitor v${MONITOR_VERSION}`);
    if (!cfg) {
        console.log("Not connected. Run `claudex connect --token <TOKEN>`.");
        return 0;
    }
    console.log("✓ connected");
    console.log(`  api:    ${cfg.apiUrl}`);
    console.log(`  token:  ${cfg.tokenPrefix}……………`);
    console.log(`  since:  ${new Date(cfg.connectedAt).toISOString()}`);
    try {
        const agg = await aggregateUTCDay();
        console.log("");
        console.log(`  today's aggregate (${agg.dateKey} UTC):`);
        console.log(`    cost          $${agg.costUSD.toFixed(2)}`);
        console.log(`    tokens        ${agg.tokens.toLocaleString()}`);
        console.log(`    requests      ${agg.requests}`);
        console.log(`    cache save    $${agg.cacheSavingsUSD.toFixed(2)}`);
        console.log(`    top model     ${agg.topModel ?? "—"}`);
    }
    catch (e) {
        console.warn("  could not compute aggregate:", e.message);
    }
    try {
        const info = await checkForUpdate(cfg.apiUrl);
        if (info?.available) {
            console.log("");
            console.log(`  ★ update available — v${info.latest} (you: ${MONITOR_VERSION})`);
            console.log(`    ${info.installCommand}`);
        }
    }
    catch {
        /* best-effort */
    }
    return 0;
}
async function cmdOnce() {
    const cfg = readCloudConfig();
    if (!cfg) {
        console.error("Not connected. Run `claudex connect --token <TOKEN>` first.");
        return 2;
    }
    const agg = await aggregateUTCDay();
    console.log(`↑ ${agg.dateKey}: $${agg.costUSD.toFixed(2)} · ${agg.tokens.toLocaleString()} tokens`);
    const r = await postToCloud(agg);
    if (!r) {
        console.error("post skipped (no config).");
        return 2;
    }
    if (r.ok) {
        console.log("✓ posted.");
        return 0;
    }
    console.error(`✗ HTTP ${r.status}:`, r.body);
    return 1;
}
function cmdStart(flags) {
    // Spawn the compiled daemon so start/stop behaves like a real process.
    const entry = join(__dirname, "index.js");
    if (!existsSync(entry)) {
        console.error("Missing dist/index.js — run `npm run build` first.");
        return Promise.resolve(1);
    }
    const args = [entry];
    if (flags["auto-update"])
        args.push("--auto-update");
    const child = spawn(process.execPath, args, {
        stdio: "inherit",
        env: process.env,
    });
    return new Promise((res) => {
        child.on("exit", (code) => res(code ?? 0));
        process.on("SIGINT", () => child.kill("SIGINT"));
        process.on("SIGTERM", () => child.kill("SIGTERM"));
    });
}
async function cmdUpdate() {
    const cfg = readCloudConfig();
    const apiUrl = cfg?.apiUrl || DEFAULT_API_URL;
    console.log(`claudex-monitor v${MONITOR_VERSION} → fetching latest…`);
    console.log(`  (${apiUrl})\n`);
    const code = await runInstaller(apiUrl);
    if (code === 0) {
        console.log(`\n✓ updated. If a daemon is running, restart it (\`claudex start\`) to pick up the new version.`);
    }
    else {
        console.error(`\n✗ update failed (exit ${code}).`);
    }
    return code;
}
async function main() {
    const { cmd, flags } = parseArgv(process.argv);
    switch (cmd) {
        case "connect":
            return cmdConnect(flags);
        case "disconnect":
            return cmdDisconnect();
        case "status":
            return cmdStatus();
        case "once":
            return cmdOnce();
        case "start":
            return cmdStart(flags);
        case "update":
            return cmdUpdate();
        case "help":
        default:
            console.log(usage());
            return 0;
    }
}
main().then((code) => process.exit(code));
//# sourceMappingURL=cli.js.map