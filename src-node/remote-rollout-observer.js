import { spawn } from "node:child_process";

const REMOTE_SCRIPT = String.raw`
import datetime, glob, json, os, time

root = os.path.expanduser("~/.codex/sessions")
cutoff = time.time() - 86400
events = []

def millis(value):
    if isinstance(value, (int, float)):
        return int(value if value > 1000000000000 else value * 1000)
    if isinstance(value, str):
        try:
            return int(datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return int(time.time() * 1000)
    return int(time.time() * 1000)

if os.path.isdir(root):
    for path in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True):
        try:
            if os.path.getmtime(path) < cutoff:
                continue
            session_id = None
            latest = None
            with open(path, "r", encoding="utf-8", errors="ignore") as handle:
                for line in handle:
                    try:
                        entry = json.loads(line)
                    except (ValueError, TypeError):
                        continue
                    payload = entry.get("payload") or {}
                    if entry.get("type") == "session_meta":
                        candidate = payload.get("id") or payload.get("session_id")
                        if isinstance(candidate, str) and len(candidate) <= 128:
                            session_id = candidate
                    elif entry.get("type") == "event_msg":
                        kind = payload.get("type")
                        if kind == "task_started":
                            latest = {"state": "running", "at": millis(payload.get("started_at"))}
                        elif kind == "task_complete":
                            latest = {"state": "failed" if payload.get("error") else "completed", "at": millis(payload.get("completed_at"))}
                        elif kind == "turn_aborted":
                            latest = {"state": "interrupted" if payload.get("reason") == "interrupted" else "failed", "at": millis(payload.get("completed_at"))}
            if session_id and latest:
                if latest["state"] == "running":
                    latest["at"] = max(latest["at"], int(os.path.getmtime(path) * 1000))
                if latest["at"] >= int(cutoff * 1000):
                    latest["sessionId"] = session_id
                    events.append(latest)
        except OSError:
            continue

print(json.dumps({"available": os.path.isdir(root), "events": events}, separators=(",", ":")))
`;

export function readRemoteRolloutActivity({ host, timeoutMs = 12_000 } = {}) {
  if (!host) return Promise.reject(new Error("Remote SSH host is not configured"));
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, "python3", "-"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"]
    });
    let output = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Remote activity read timed out")), timeoutMs);
    child.once("error", () => finish(new Error("Unable to start remote SSH activity reader")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("close", (code) => {
      if (code !== 0) return finish(new Error("Remote SSH activity reader failed"));
      try { finish(null, parseRemoteActivity(output)); }
      catch { finish(new Error("Remote activity response was invalid")); }
    });
    child.stdin.end(REMOTE_SCRIPT);
  });
}

export function parseRemoteActivity(output) {
  const parsed = JSON.parse(output);
  if (typeof parsed?.available !== "boolean" || !Array.isArray(parsed?.events)) throw new Error("Unsupported remote activity response");
  const events = parsed.events.filter((event) =>
    typeof event?.sessionId === "string" && ["running", "completed", "failed", "interrupted"].includes(event.state) && Number.isFinite(event.at)
  ).map(({ sessionId, state, at }) => ({ sessionId, state, at }));
  return { available: parsed.available, events };
}
