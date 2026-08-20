# Troubleshooting reference

## What healthy means

Health requires all of the following: a live Node process for `src-node/server.js`, TCP port 43117 listening, a successful local HTTP response, and a current runtime status file. A scheduler or LaunchAgent entry alone is not proof that the page works.

## Pairing

- Codes expire after 10 minutes. Restart the service to generate a new code.
- A successful browser session lasts 12 hours.
- Five failed attempts in one minute trigger a temporary rate limit.

## Network

- Only loopback, RFC1918 IPv4, IPv6 link-local, and IPv6 ULA clients are accepted.
- The phone and computer must be on the same trusted Wi-Fi without client isolation.
- Never work around a LAN problem by exposing the service to the internet.

## Remote computer

Remote monitoring is optional and disabled by default. It requires an existing key-based SSH alias or hostname and a usable Codex CLI on the remote computer. A remote outage must only mark that source unavailable; local quota and tasks should continue.

## Privacy

The browser snapshot may include task titles unless Hide titles is enabled. It must never include prompt/reply content, reasoning, tool calls, filesystem paths, raw rollout JSON, account identifiers, or task/session identifiers.
