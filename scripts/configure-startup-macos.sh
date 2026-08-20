#!/bin/sh
set -eu

action="${1:-status}"
label="com.lucasgogogo.codex-phone-dashboard"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_root="$(dirname -- "$script_dir")"
node_path="$(command -v node)"
agent_dir="$HOME/Library/LaunchAgents"
plist_path="$agent_dir/$label.plist"
support_dir="$HOME/Library/Application Support/CodexPhoneDashboard"
runtime_path="$support_dir/runtime-info.json"
log_dir="$HOME/Library/Logs/CodexPhoneDashboard"
domain="gui/$(id -u)"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

write_plist() {
  mkdir -p "$agent_dir" "$support_dir" "$log_dir"
  chmod 700 "$support_dir"
  escaped_node="$(xml_escape "$node_path")"
  escaped_server="$(xml_escape "$project_root/src-node/server.js")"
  escaped_root="$(xml_escape "$project_root")"
  escaped_runtime="$(xml_escape "$runtime_path")"
  escaped_stdout="$(xml_escape "$log_dir/dashboard.log")"
  escaped_stderr="$(xml_escape "$log_dir/dashboard-error.log")"
  remote_environment=""
  if [ -n "${CODEX_PHONE_REMOTE_SSH_HOST:-}" ]; then
    remote_environment="
    <key>CODEX_PHONE_REMOTE_SSH_HOST</key><string>$(xml_escape "$CODEX_PHONE_REMOTE_SSH_HOST")</string>"
    if [ -n "${CODEX_PHONE_REMOTE_CODEX_BIN:-}" ]; then
      remote_environment="$remote_environment
    <key>CODEX_PHONE_REMOTE_CODEX_BIN</key><string>$(xml_escape "$CODEX_PHONE_REMOTE_CODEX_BIN")</string>"
    fi
    if [ -n "${CODEX_PHONE_REMOTE_LABEL:-}" ]; then
      remote_environment="$remote_environment
    <key>CODEX_PHONE_REMOTE_LABEL</key><string>$(xml_escape "$CODEX_PHONE_REMOTE_LABEL")</string>"
    fi
  fi
  tee "$plist_path" >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$escaped_node</string><string>$escaped_server</string></array>
  <key>WorkingDirectory</key><string>$escaped_root</string>
  <key>EnvironmentVariables</key>
  <dict><key>CODEX_PHONE_RUNTIME_PATH</key><string>$escaped_runtime</string>$remote_environment
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$escaped_stdout</string>
  <key>StandardErrorPath</key><string>$escaped_stderr</string>
</dict>
</plist>
PLIST
  chmod 600 "$plist_path"
  plutil -lint "$plist_path" >/dev/null
}

show_status() {
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    printf 'State: Running\n'
  else
    printf 'State: Stopped\n'
  fi
  if [ -f "$runtime_path" ]; then
    "$node_path" -e 'const fs=require("fs");const p=process.argv[1];const x=JSON.parse(fs.readFileSync(p,"utf8"));console.log("Pairing code:",x.pairingCode);console.log("URLs:",(x.urls||[]).join(", "));' "$runtime_path"
  fi
}

case "$action" in
  install)
    write_plist
    launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
    launchctl bootstrap "$domain" "$plist_path"
    show_status
    ;;
  remove)
    launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
    rm -f "$plist_path"
    show_status
    ;;
  start)
    [ -f "$plist_path" ] || { printf 'Not installed. Run: %s install\n' "$0" >&2; exit 1; }
    launchctl bootstrap "$domain" "$plist_path" 2>/dev/null || launchctl kickstart -k "$domain/$label"
    show_status
    ;;
  stop)
    launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
    show_status
    ;;
  restart)
    launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
    launchctl bootstrap "$domain" "$plist_path"
    show_status
    ;;
  status) show_status ;;
  *) printf 'Usage: %s {install|remove|start|stop|restart|status}\n' "$0" >&2; exit 2 ;;
esac
