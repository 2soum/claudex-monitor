import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, unlinkSync, } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = resolve(__dirname, "index.js");
const NODE_BIN = process.execPath;
const LOG_DIR = join(homedir(), ".claudex");
const LOG_FILE = join(LOG_DIR, "daemon.log");
export function installService() {
    const p = platform();
    if (p === "darwin")
        return installLaunchd();
    if (p === "linux")
        return installSystemdUser();
    if (p === "win32")
        return installWindowsTask();
    return { ok: false, message: `unsupported platform: ${p}` };
}
export function uninstallService() {
    const p = platform();
    if (p === "darwin")
        return uninstallLaunchd();
    if (p === "linux")
        return uninstallSystemdUser();
    if (p === "win32")
        return uninstallWindowsTask();
    return { ok: false, message: `unsupported platform: ${p}` };
}
/* -------------------------------------------------------------------------- */
/*  macOS — launchd user agent                                                */
/* -------------------------------------------------------------------------- */
const LAUNCH_LABEL = "app.claudex.monitor";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
function installLaunchd() {
    mkdirSync(LOG_DIR, { recursive: true });
    mkdirSync(dirname(PLIST_PATH), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LAUNCH_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${DAEMON_ENTRY}</string>
        <string>--auto-update</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${LOG_FILE}</string>
    <key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict>
</plist>
`;
    writeFileSync(PLIST_PATH, plist);
    // Unload if already loaded so we don't double-run.
    spawnSync("launchctl", ["unload", PLIST_PATH], { stdio: "ignore" });
    const r = spawnSync("launchctl", ["load", "-w", PLIST_PATH], {
        stdio: "ignore",
    });
    if (r.status === 0) {
        return {
            ok: true,
            message: `launchd agent loaded · auto-starts at login · logs at ${LOG_FILE}`,
            logFile: LOG_FILE,
        };
    }
    return {
        ok: false,
        message: `launchctl load failed (exit ${r.status}) · plist at ${PLIST_PATH}`,
    };
}
function uninstallLaunchd() {
    if (!existsSync(PLIST_PATH))
        return { ok: true, message: "no launchd agent to remove" };
    spawnSync("launchctl", ["unload", PLIST_PATH], { stdio: "ignore" });
    unlinkSync(PLIST_PATH);
    return { ok: true, message: "launchd agent removed" };
}
/* -------------------------------------------------------------------------- */
/*  Linux — systemd --user                                                    */
/* -------------------------------------------------------------------------- */
const SYSTEMD_NAME = "claudex";
const SVC_PATH = join(homedir(), ".config", "systemd", "user", `${SYSTEMD_NAME}.service`);
function installSystemdUser() {
    // Sanity check: is systemctl --user actually usable? (WSL/minimal distros often aren't.)
    const probe = spawnSync("systemctl", ["--user", "is-system-running"], {
        stdio: "ignore",
        timeout: 3000,
    });
    if (probe.error) {
        return {
            ok: false,
            message: "systemctl not found · run `claudex start` manually, or wrap in your own supervisor",
        };
    }
    mkdirSync(LOG_DIR, { recursive: true });
    mkdirSync(dirname(SVC_PATH), { recursive: true });
    const svc = `[Unit]
Description=Claudex Monitor
After=default.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${DAEMON_ENTRY} --auto-update
Restart=always
RestartSec=3
RestartForceExitStatus=72
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
`;
    writeFileSync(SVC_PATH, svc);
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    const r = spawnSync("systemctl", ["--user", "enable", "--now", SYSTEMD_NAME], { stdio: "ignore" });
    if (r.status === 0) {
        return {
            ok: true,
            message: `systemd --user ${SYSTEMD_NAME}.service enabled · logs at ${LOG_FILE}`,
            logFile: LOG_FILE,
        };
    }
    return {
        ok: false,
        message: `systemctl enable failed (exit ${r.status}) · service file at ${SVC_PATH}`,
    };
}
function uninstallSystemdUser() {
    if (!existsSync(SVC_PATH))
        return { ok: true, message: "no systemd service to remove" };
    spawnSync("systemctl", ["--user", "disable", "--now", SYSTEMD_NAME], {
        stdio: "ignore",
    });
    unlinkSync(SVC_PATH);
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    return { ok: true, message: "systemd --user service removed" };
}
/* -------------------------------------------------------------------------- */
/*  Windows — Task Scheduler + supervisor wrapper                             */
/* -------------------------------------------------------------------------- */
const WIN_TASK = "ClaudexMonitor";
const WIN_WRAPPER = join(LOG_DIR, "daemon.cmd");
function installWindowsTask() {
    mkdirSync(LOG_DIR, { recursive: true });
    // Supervisor wrapper — a while-loop that restarts the daemon on exit 72
    // (and on any other non-zero). Task Scheduler kicks this off at logon.
    const wrapper = `@echo off
setlocal
:loop
"${NODE_BIN}" "${DAEMON_ENTRY}" --auto-update >> "${LOG_FILE}" 2>&1
timeout /t 2 /nobreak > nul
goto loop
`;
    writeFileSync(WIN_WRAPPER, wrapper);
    // Idempotent: remove old task first.
    spawnSync("schtasks", ["/end", "/tn", WIN_TASK], {
        stdio: "ignore",
        shell: true,
    });
    spawnSync("schtasks", ["/delete", "/tn", WIN_TASK, "/f"], {
        stdio: "ignore",
        shell: true,
    });
    const r = spawnSync("schtasks", [
        "/create",
        "/tn",
        WIN_TASK,
        "/tr",
        `"${WIN_WRAPPER}"`,
        "/sc",
        "ONLOGON",
        "/rl",
        "LIMITED",
        "/f",
    ], { stdio: "ignore", shell: true });
    if (r.status !== 0) {
        return {
            ok: false,
            message: `schtasks create failed (exit ${r.status})`,
        };
    }
    spawnSync("schtasks", ["/run", "/tn", WIN_TASK], {
        stdio: "ignore",
        shell: true,
    });
    return {
        ok: true,
        message: `Task Scheduler task '${WIN_TASK}' created · auto-starts at logon · logs at ${LOG_FILE}`,
        logFile: LOG_FILE,
    };
}
function uninstallWindowsTask() {
    spawnSync("schtasks", ["/end", "/tn", WIN_TASK], {
        stdio: "ignore",
        shell: true,
    });
    const r = spawnSync("schtasks", ["/delete", "/tn", WIN_TASK, "/f"], {
        stdio: "ignore",
        shell: true,
    });
    if (existsSync(WIN_WRAPPER)) {
        try {
            unlinkSync(WIN_WRAPPER);
        }
        catch {
            /* ignore */
        }
    }
    return {
        ok: r.status === 0,
        message: r.status === 0
            ? "Task Scheduler task removed"
            : "no Task Scheduler task to remove",
    };
}
//# sourceMappingURL=serviceInstall.js.map