import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function readRolloutActivity({ now = Date.now(), sessionsRoot } = {}) {
  const root = sessionsRoot || process.env.CODEX_PHONE_SESSIONS_DIR || join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return { available: false, events: [] };
  const files = collectJsonl(root, now - DAY_MS);
  const events = [];
  for (const file of files) {
    const event = await parseRollout(file);
    if (event && event.at >= now - DAY_MS) events.push(event);
  }
  return { available: true, events };
}

export async function parseRollout(file) {
  let sessionId = null;
  let latest = null;
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === "session_meta") {
      sessionId = safeId(entry.payload?.id) || safeId(entry.payload?.session_id) || sessionId;
      continue;
    }
    if (entry?.type !== "event_msg") continue;
    const payload = entry.payload || {};
    const mapped = mapEvent(payload);
    if (mapped) latest = { ...mapped, sessionId };
  }
  return latest?.sessionId ? latest : null;
}

function mapEvent(payload) {
  if (payload.type === "task_started") return { state: "running", at: parseTime(payload.started_at) };
  if (payload.type === "task_complete") {
    return { state: payload.error ? "failed" : "completed", at: parseTime(payload.completed_at) };
  }
  if (payload.type === "turn_aborted") {
    return { state: payload.reason === "interrupted" ? "interrupted" : "failed", at: parseTime(payload.completed_at) };
  }
  return null;
}

function parseTime(value) {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function safeId(value) {
  return typeof value === "string" && value.length <= 128 ? value : null;
}

function collectJsonl(root, cutoff) {
  const output = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try { if (statSync(full).mtimeMs >= cutoff) output.push(full); } catch {}
      }
    }
  }
  return output;
}
