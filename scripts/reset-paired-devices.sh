#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
support_dir="$HOME/Library/Application Support/CodexPhoneDashboard"
auth_state="$support_dir/auth-state.json"
plist_path="$HOME/Library/LaunchAgents/com.lucasgogogo.codex-phone-dashboard.plist"
domain="gui/$(id -u)"

[ -f "$plist_path" ] || { printf 'Reset requires the installed LaunchAgent. Foreground npm start mode is diagnostic-only.\n' >&2; exit 1; }
old_hash=""
if [ -f "$auth_state" ]; then
  old_hash="$(shasum -a 256 "$auth_state" | awk '{print $1}')"
fi

"$script_dir/configure-startup-macos.sh" stop >/dev/null
if launchctl print "$domain/com.lucasgogogo.codex-phone-dashboard" >/dev/null 2>&1; then
  printf 'The Dashboard LaunchAgent is still running; authorization was not changed.\n' >&2
  exit 1
fi
rm -f "$auth_state"
"$script_dir/configure-startup-macos.sh" start
attempt=0
while [ ! -f "$auth_state" ] && [ "$attempt" -lt 15 ]; do
  sleep 1
  attempt=$((attempt + 1))
done
[ -f "$auth_state" ] || { printf 'The replacement authorization state was not created.\n' >&2; exit 1; }
new_hash="$(shasum -a 256 "$auth_state" | awk '{print $1}')"
[ -z "$old_hash" ] || [ "$old_hash" != "$new_hash" ] || { printf 'Authorization state did not rotate.\n' >&2; exit 1; }
