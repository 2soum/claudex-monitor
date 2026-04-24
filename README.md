# Claudex Monitor

Local daemon for Claude Code users. Does two things:

1. **LAN live stream** — reads `~/.claude/projects/*.jsonl` and broadcasts real-time token/cost snapshots over WebSocket + Bonjour, so an iPad companion on the same network can display your burn live.
2. **Public leaderboard** — aggregates today's usage (UTC) and posts it every 5 minutes to [claudex-topaz.vercel.app](https://claudex-topaz.vercel.app) so your `@handle` shows up on the global board.

Prompts and source code never leave your machine. Only these numbers are sent: `costUSD`, `tokens`, `requests`, `cacheSavingsUSD`, `topModel`, `dateKey`.

## Install

Works on **macOS**, **Linux**, and **Windows**. Prerequisites: Node 20+, pnpm (or npm), git.

### macOS / Linux

```sh
git clone https://github.com/2soum/claudex-monitor
cd claudex-monitor && pnpm install && pnpm build && npm link
```

### Windows (PowerShell)

```powershell
git clone https://github.com/2soum/claudex-monitor
cd claudex-monitor
pnpm install; pnpm build; npm link
```

After install, the `claudex` CLI is on your PATH. On Windows if PowerShell blocks the link step, run once as admin:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

> Claudex reads `~/.claude/projects/*.jsonl` (that's `%USERPROFILE%\.claude\projects` on Windows). As long as Claude Code has written sessions there, the monitor picks them up.

## Connect

1. Sign in at <https://claudex-topaz.vercel.app/app> with Google.
2. Click **Regenerate token** — copy the raw token (it's shown once).
3. Run:

   ```sh
   claudex connect --token <THE_TOKEN>
   ```

   (custom API URL? add `--api https://your-vercel-deployment.vercel.app`)

4. Post your first aggregate now, don't wait:

   ```sh
   claudex once
   ```

5. Start the full daemon (LAN + periodic cloud post):

   ```sh
   claudex start
   ```

## Commands

| Command | Description |
| --- | --- |
| `claudex connect --token <T> [--api <URL>]` | Stores the token in `~/.claudex/config.json` (0600) |
| `claudex status` | Shows current config + today's dry-run aggregate |
| `claudex once` | Aggregates today (UTC) and POSTs once |
| `claudex start` | Starts the full daemon: Bonjour + WebSocket + periodic cloud post |
| `claudex disconnect` | Removes the local config (regenerate token on the web to fully rotate) |
| `claudex update` | Pull + rebuild the latest version. Re-run `claudex start` after to pick up the new code. |
| `claudex start --auto-update` | Daemon self-updates when a new release lands. Exits with code 72 so your supervisor restarts it on new code. |

## Auto-update under a supervisor

`--auto-update` is designed to play nice with whatever keeps the process alive.

### systemd (Linux)

```ini
[Service]
ExecStart=/home/you/.local/bin/claudex start --auto-update
RestartForceExitStatus=72
Restart=always
```

### launchd (macOS)

```xml
<key>KeepAlive</key><true/>
<key>ProgramArguments</key>
<array>
  <string>/Users/you/.local/bin/claudex</string>
  <string>start</string>
  <string>--auto-update</string>
</array>
```

### nssm (Windows)

Point nssm at `claudex.cmd start --auto-update` and set `AppExit Default Restart` + restart delay.

### One-liner supervisor

```sh
while :; do claudex start --auto-update || true; sleep 1; done
```

## Running in the background

**macOS / Linux (launchd or systemd):** TBD — for now, run `claudex start` in a detached `tmux` session, or a `nohup claudex start >/tmp/claudex.log 2>&1 &`.

**Windows:** use Task Scheduler to run `claudex start` at login, or [nssm](https://nssm.cc/) to install it as a Windows service.

## What gets sent to the cloud

Every 5 minutes, one `POST /api/ingest`:

```json
{
  "dateKey": "2026-04-22",
  "costUSD": 42.18,
  "tokens": 1234567,
  "requests": 40,
  "cacheSavingsUSD": 18.40,
  "topModel": "claude-opus-4-7"
}
```

Authenticated with `Authorization: Bearer <token>`. Hard-capped per field server-side ($10k/day cost, 10B tokens, etc.) — no way to stunt-bomb the board.

## Privacy

- **Never sent**: your prompts, your responses, file paths, project names, JSONL contents, process list, IP, anything else.
- **Sent daily**: the six numeric fields above.
- **Stored on your disk**: the monitor token, 0600 perms, at `~/.claudex/config.json`.

## Environment overrides

| Var | Default | Notes |
| --- | --- | --- |
| `CLAUDEX_POST_INTERVAL_MS` | `300000` (5 min) | How often to POST aggregates |
| `CLAUDEX_API_URL` | `https://claudex-topaz.vercel.app` | Override if you self-host the web app |
| `PORT` | `7337` | LAN WebSocket port |
| `CLAUDE_PRICING_FILE` | _(unset)_ | Optional JSON pricing override for experimental models |
| `CLAUDE_WINDOW_LIMIT` | _(unset)_ | Force the 5h token limit (rarely needed) |

## Upstream

This is a fork of [`BlueShork/claude-token-monitor-server`](https://github.com/BlueShork/claude-token-monitor-server) with the cloud-poster + CLI added on top. Core JSONL reader, RTK calculator, and WebSocket broadcaster are unchanged.
