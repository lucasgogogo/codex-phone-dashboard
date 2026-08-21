import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DASHBOARD_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

const SOURCE_KINDS = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"
];

export class AppServerClient {
  constructor(command = defaultCommand(), timeoutMs = 6000) {
    this.command = command;
    this.timeoutMs = timeoutMs;
  }

  readQuota() {
    return this.#rpc({ id: 2, method: "account/rateLimits/read", params: null });
  }

  async readThreads() {
    const tasks = [];
    const seen = new Set();
    let cursor = null;
    do {
      const result = await this.#rpc({
        id: 2,
        method: "thread/list",
        params: {
          cursor,
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived: false,
          sourceKinds: SOURCE_KINDS,
          useStateDbOnly: true
        }
      });
      const page = parseThreadPage(result);
      tasks.push(...page.tasks);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("Codex returned a repeated thread cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return tasks;
  }

  #rpc(request) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command.program, [...this.command.prefixArgs, "app-server", "--stdio"], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"]
      });
      let buffer = "";
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        error ? reject(error) : resolve(value);
      };
      const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      const timer = setTimeout(() => finish(new Error("Codex app-server timed out")), this.timeoutMs);

      child.once("error", () => finish(new Error("Unable to start Codex app-server")));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1) {
            send({ method: "initialized" });
            send(request);
          } else if (message.id === request.id) {
            if (message.error) finish(new Error("Codex app-server rejected the request"));
            else if (!("result" in message)) finish(new Error("Codex app-server response had no result"));
            else finish(null, message.result);
          }
        }
      });
      send({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "codex-phone-dashboard", version: DASHBOARD_VERSION } }
      });
    });
  }
}

function defaultCommand() {
  if (process.env.CODEX_PHONE_CODEX_BIN) {
    return { program: process.env.CODEX_PHONE_CODEX_BIN, prefixArgs: [] };
  }
  const localCli = fileURLToPath(new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url));
  return { program: process.execPath, prefixArgs: [localCli] };
}

export function parseQuota(result) {
  const limits = result?.rateLimits;
  if (!limits?.primary) throw new Error("Codex quota response is unsupported");
  const windows = [limits.primary, limits.secondary].filter(Boolean).map((item) => {
    const used = Number(item.usedPercent);
    const duration = Number(item.windowDurationMins);
    const resetsAt = Number(item.resetsAt);
    if (!Number.isFinite(used) || used < 0 || used > 100 || duration <= 0 || !Number.isFinite(resetsAt)) {
      throw new Error("Codex quota response contains invalid values");
    }
    return { name: formatWindow(duration), usedPercent: used, resetsAt, windowDurationMins: duration };
  });
  return {
    windows,
    resetCredits: Math.max(0, Number(result.rateLimitResetCredits?.availableCount || 0)),
    stale: false
  };
}

export function parseThreadPage(result) {
  const data = Array.isArray(result?.data) ? result.data : [];
  return {
    tasks: data.map((thread) => ({
      id: stringOrNull(thread.id),
      sessionId: stringOrNull(thread.sessionId),
      title: typeof thread.name === "string" && thread.name.trim() ? thread.name.trim() : "未命名任务",
      parentThreadId: stringOrNull(thread.parentThreadId),
      source: typeof thread.source === "string" ? thread.source : "unknown",
      appStatus: normalizeStatus(thread.status),
      updatedAt: normalizeTimestamp(thread.updatedAt)
    })).filter((thread) => thread.id || thread.sessionId),
    nextCursor: stringOrNull(result?.nextCursor)
  };
}

function normalizeStatus(value) {
  const status = typeof value === "string" ? value : value?.type;
  return ["active", "idle", "notLoaded"].includes(status) ? status : null;
}

function normalizeTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 1e12 ? number * 1000 : number;
}

function stringOrNull(value) {
  return typeof value === "string" && value ? value : null;
}

function formatWindow(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}
