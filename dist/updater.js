import { spawn } from "node:child_process";
import { readCloudConfig, DEFAULT_API_URL } from "./cloudConfig.js";
/**
 * Re-runs the canonical install script for the current platform. The install
 * script clones/updates ~/.claudex-monitor, reinstalls deps, rebuilds, and
 * re-links the `claudex` binary. Runs with stdio inherited so the caller sees
 * progress live.
 */
export function spawnInstaller(apiUrl) {
    const base = (apiUrl || readCloudConfig()?.apiUrl || DEFAULT_API_URL).replace(/\/$/, "");
    if (process.platform === "win32") {
        return spawn("powershell", [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            `irm ${base}/install.ps1 | iex`,
        ], { stdio: "inherit" });
    }
    return spawn("bash", ["-c", `curl -fsSL ${base}/install.sh | bash`], { stdio: "inherit" });
}
export function runInstaller(apiUrl) {
    return new Promise((resolve) => {
        const child = spawnInstaller(apiUrl);
        child.on("exit", (code) => resolve(code ?? 0));
        child.on("error", () => resolve(1));
    });
}
/** Exit code the daemon uses after a successful auto-update to ask the
 * supervisor to restart it. `systemd` uses RestartForceExitStatus=72 etc. */
export const RESTART_EXIT_CODE = 72;
//# sourceMappingURL=updater.js.map