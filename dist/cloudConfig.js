import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, } from "node:fs";
/**
 * Where Claudex stores the user's monitor token & API URL.
 * We scope to a directory the user owns, write with 0600, never log the token.
 */
export const CONFIG_DIR = join(homedir(), ".claudex");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const DEFAULT_API_URL = "https://claudex-topaz.vercel.app";
export function readCloudConfig() {
    if (!existsSync(CONFIG_PATH))
        return null;
    try {
        const raw = readFileSync(CONFIG_PATH, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed.token)
            return null;
        return {
            token: parsed.token,
            apiUrl: parsed.apiUrl || DEFAULT_API_URL,
            connectedAt: parsed.connectedAt || Date.now(),
            tokenPrefix: parsed.tokenPrefix || parsed.token.slice(0, 8),
        };
    }
    catch {
        return null;
    }
}
export function writeCloudConfig(cfg) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    try {
        chmodSync(CONFIG_PATH, 0o600);
    }
    catch {
        /* best-effort on non-POSIX filesystems */
    }
}
export function clearCloudConfig() {
    if (existsSync(CONFIG_PATH)) {
        // Overwrite before delete so the token isn't recoverable from raw blocks.
        try {
            writeFileSync(CONFIG_PATH, "{}");
        }
        catch {
            /* ignore */
        }
        try {
            writeFileSync(CONFIG_PATH, "");
        }
        catch {
            /* ignore */
        }
    }
}
//# sourceMappingURL=cloudConfig.js.map