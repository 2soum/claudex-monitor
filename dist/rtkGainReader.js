import { spawn } from "node:child_process";
export function readRtkGain(timeoutMs = 3000) {
    return new Promise((resolve) => {
        let finished = false;
        const finish = (val) => {
            if (finished)
                return;
            finished = true;
            resolve(val);
        };
        const child = spawn("rtk", ["gain", "-f", "json"], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            finish(null);
        }, timeoutMs);
        child.stdout.on("data", (d) => (out += d.toString()));
        child.on("error", () => {
            clearTimeout(timer);
            finish(null);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0 || !out)
                return finish(null);
            try {
                const parsed = JSON.parse(out);
                const s = parsed.summary;
                if (!s || typeof s.total_commands !== "number")
                    return finish(null);
                finish({
                    totalCommands: s.total_commands ?? 0,
                    totalInputTokens: s.total_input ?? 0,
                    totalOutputTokens: s.total_output ?? 0,
                    totalSavedTokens: s.total_saved ?? 0,
                    avgSavingsPct: s.avg_savings_pct ?? 0,
                    totalTimeMs: s.total_time_ms ?? 0,
                    avgTimeMs: s.avg_time_ms ?? 0,
                });
            }
            catch {
                finish(null);
            }
        });
    });
}
//# sourceMappingURL=rtkGainReader.js.map