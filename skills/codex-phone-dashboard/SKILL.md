---
name: codex-phone-dashboard
description: Install, start, update, remove, or diagnose the private Codex Phone Dashboard on Windows or macOS. Use when a user wants to view read-only Codex quota and recent task status on a phone over the same trusted Wi-Fi.
---

# Codex Phone Dashboard

Operate the open-source dashboard from `lucasgogogo/codex-phone-dashboard`. Keep the service private, read-only, and beginner-friendly.

## Non-negotiable boundaries

- Bind only to loopback or a private LAN. Never create public hosting, port forwarding, reverse proxies, or tunnels.
- Never expose prompts, replies, reasoning, tool arguments, working directories, account IDs, raw rollout files, or internal task/session IDs.
- Keep the six-digit pairing gate enabled.
- Default to the current computer only. Configure an SSH remote only when the user explicitly requests it and already has key-based SSH working.
- Ask before changing firewall rules, login-startup configuration, SSH settings, or Git state.
- Report Windows and macOS verification separately. Do not claim a platform was tested when it was only statically checked.

## Install workflow

1. Detect the OS and confirm Node.js 20 or newer and Git are available.
2. If the repository is not present, ask where to install it, then clone `https://github.com/lucasgogogo/codex-phone-dashboard.git`.
3. Read the matching language README and `references/troubleshooting.md`.
4. Run `npm install` and `npm test` from the repository root.
5. Explain the exact system changes and obtain approval before running the OS installer:
   - Windows: `scripts/install-windows.ps1` adds a LocalSubnet-only firewall rule and a current-user logon task.
   - macOS: `scripts/install-macos.sh` adds a current-user LaunchAgent under `~/Library/LaunchAgents`.
6. Read the runtime status, give the user the private LAN URL and short-lived pairing code, then verify the HTTP page locally.
7. Ask the user to open the URL on a phone connected to the same trusted Wi-Fi and enter the code.

## Operations

- Windows status/start/stop/restart/remove: `scripts/configure-startup-task.ps1 -Action <Status|Start|Stop|Restart|Remove>`.
- macOS status/start/stop/restart/remove: `scripts/configure-startup-macos.sh <status|start|stop|restart|remove>`.
- Foreground diagnostic mode on either OS: `npm start`.
- Optional remote host: copy `config.example.json` to ignored `config.local.json`, set `remoteSshHost`, and restart. `CODEX_PHONE_REMOTE_` environment variables are advanced overrides.

## Diagnose in order

1. Confirm the dashboard process is alive.
2. Confirm Node.js can read the local Codex app-server.
3. Confirm the printed URL uses a private address and port 43117 is listening.
4. Confirm computer and phone are on the same trusted Wi-Fi.
5. On Windows, inspect the exact LocalSubnet firewall rule; on macOS, inspect the LaunchAgent and logs.
6. If a remote source was configured, diagnose it last so remote failure cannot hide local health.

Stop and explain the proven blocker when a required capability is missing. Do not invent a successful state.
