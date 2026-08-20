import { createServer } from "node:http";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { hostname, networkInterfaces } from "node:os";
import { extname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SnapshotService } from "./snapshot-service.js";
import { AppServerClient } from "./app-server-client.js";
import { readRemoteRolloutActivity } from "./remote-rollout-observer.js";
import { createRuntimeInfo, writeRuntimeInfo } from "./runtime-info.js";

const PORT = Number(process.env.CODEX_PHONE_PORT || 43117);
const HOST = process.env.CODEX_PHONE_HOST || "0.0.0.0";
const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));
const LOCAL_CONFIG_PATH = fileURLToPath(new URL("../config.local.json", import.meta.url));
const LOCAL_CONFIG = readLocalConfig();
const PIN = String(randomInt(100000, 1000000));
const SESSION = randomBytes(32).toString("base64url");
const PAIR_WINDOW_MS = 10 * 60 * 1000;
const startedAt = Date.now();
const attempts = new Map();
const streams = new Set();
const REMOTE_SSH_HOST = String(process.env.CODEX_PHONE_REMOTE_SSH_HOST || LOCAL_CONFIG.remoteSshHost || "").trim();
const REMOTE_CODEX_BIN = String(process.env.CODEX_PHONE_REMOTE_CODEX_BIN || LOCAL_CONFIG.remoteCodexBin || "codex").trim();
const execFileAsync = promisify(execFile);
const LOCAL_MACHINE_LABEL = normalizeMachineLabel(process.env.CODEX_PHONE_LOCAL_LABEL || hostname(), "LOCAL");
let companyMachineLabel = normalizeMachineLabel(process.env.CODEX_PHONE_REMOTE_LABEL || LOCAL_CONFIG.remoteLabel || REMOTE_SSH_HOST, "REMOTE");
const companyClient = REMOTE_SSH_HOST ? new AppServerClient({
  program: "ssh",
  prefixArgs: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", REMOTE_SSH_HOST, REMOTE_CODEX_BIN]
}, 12_000) : null;
const service = new SnapshotService({
  companyClient,
  companyObserver: REMOTE_SSH_HOST ? () => readRemoteRolloutActivity({ host: REMOTE_SSH_HOST }) : null,
  personalLabel: LOCAL_MACHINE_LABEL,
  companyLabel: () => companyMachineLabel
});
let snapshot = null;

const server = createServer(async (request, response) => {
  secureHeaders(response);
  const remote = normalizeIp(request.socket.remoteAddress);
  if (!isPrivateIp(remote)) return send(response, 403, "text/plain; charset=utf-8", "Local network only");
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "POST" && url.pathname === "/api/pair") return pair(request, response, remote);
  if (request.method === "GET" && url.pathname === "/api/session") return sendJson(response, 200, { authenticated: isAuthenticated(request) });
  if (url.pathname.startsWith("/api/") || url.pathname === "/events") {
    if (!isAuthenticated(request)) return sendJson(response, 401, { errorCode: "pairingRequired" });
  }
  if (request.method === "GET" && url.pathname === "/api/snapshot") return sendJson(response, 200, snapshot || emptySnapshot());
  if (request.method === "GET" && url.pathname === "/events") return openStream(request, response);
  if (request.method !== "GET") return send(response, 405, "text/plain; charset=utf-8", "Method not allowed");
  return serveStatic(url.pathname, response);
});

server.listen(PORT, HOST, async () => {
  if (REMOTE_SSH_HOST) companyMachineLabel = await readRemoteMachineLabel();
  await refresh();
  const addresses = lanAddresses();
  try {
    await writeRuntimeInfo(createRuntimeInfo({
      pairingCode: PIN,
      pairingExpiresAt: startedAt + PAIR_WINDOW_MS,
      port: PORT,
      addresses,
      processId: process.pid
    }));
  } catch { console.warn("Unable to write local runtime status."); }
  console.log("\nCodex Phone Dashboard started");
  console.log(`Pairing code (valid for 10 minutes): ${PIN}`);
  for (const address of addresses) console.log(`Open on your phone: http://${address}:${PORT}`);
  console.log("Press Ctrl+C to stop.\n");
});

const interval = setInterval(refresh, 10_000);
interval.unref();

async function refresh() {
  try { snapshot = await service.refresh(); }
  catch { snapshot = snapshot ? { ...snapshot, activityStale: true } : emptySnapshot(); }
  const event = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
  for (const stream of streams) stream.write(event);
}

async function pair(request, response, remote) {
  if (Date.now() - startedAt > PAIR_WINDOW_MS) return sendJson(response, 410, { errorCode: "pairingExpired" });
  const history = attempts.get(remote) || [];
  const recent = history.filter((time) => Date.now() - time < 60_000);
  if (recent.length >= 5) return sendJson(response, 429, { errorCode: "tooManyAttempts" });
  attempts.set(remote, [...recent, Date.now()]);
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024) return sendJson(response, 413, { errorCode: "requestTooLarge" });
  }
  let supplied = "";
  try { supplied = String(JSON.parse(body).pin || ""); } catch {}
  if (!safeEqual(supplied, PIN)) return sendJson(response, 401, { errorCode: "pairingIncorrect" });
  response.setHeader("Set-Cookie", `codex_phone_session=${SESSION}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
  return sendJson(response, 200, { ok: true });
}

function openStream(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive"
  });
  response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot || emptySnapshot())}\n\n`);
  streams.add(response);
  request.on("close", () => streams.delete(response));
}

async function serveStatic(pathname, response) {
  const routes = {
    "/": "index.html", "/app.js": "app.js", "/styles.css": "styles.css",
    "/assets/progress-mascot.gif": "assets/progress-mascot.gif"
  };
  const file = routes[pathname];
  if (!file) return send(response, 404, "text/plain; charset=utf-8", "Not found");
  try {
    const data = await readFile(join(WEB_ROOT, file));
    const mime = {
      ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8", ".gif": "image/gif"
    }[extname(file)];
    return send(response, 200, mime, data);
  } catch { return send(response, 500, "text/plain; charset=utf-8", "Dashboard assets unavailable"); }
}

function isAuthenticated(request) {
  const cookie = request.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)codex_phone_session=([^;]+)/);
  return match ? safeEqual(match[1], SESSION) : false;
}

function safeEqual(left, right) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeIp(value = "") { return value.startsWith("::ffff:") ? value.slice(7) : value; }
export function isPrivateIp(ip) {
  if (ip === "::1" || ip === "127.0.0.1") return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;
  const match = ip.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe[89ab][0-9a-f]:/i.test(ip);
}

function lanAddresses() {
  const values = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const item of addresses || []) if (item.family === "IPv4" && !item.internal && isPrivateIp(item.address)) values.push(item.address);
  }
  return [...new Set(values)];
}

async function readRemoteMachineLabel() {
  if (process.env.CODEX_PHONE_REMOTE_LABEL || LOCAL_CONFIG.remoteLabel) return companyMachineLabel;
  try {
    const { stdout } = await execFileAsync("ssh", [
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", REMOTE_SSH_HOST, "hostname", "-s"
    ], { timeout: 10_000, windowsHide: true });
    return normalizeMachineLabel(stdout, companyMachineLabel);
  } catch { return companyMachineLabel; }
}

function normalizeMachineLabel(value, fallback) {
  const label = String(value || "").trim().replace(/\.local$/i, "");
  return label ? label.slice(0, 40) : fallback;
}

function readLocalConfig() {
  try {
    const parsed = JSON.parse(readFileSync(LOCAL_CONFIG_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return {
      remoteSshHost: typeof parsed.remoteSshHost === "string" ? parsed.remoteSshHost : "",
      remoteCodexBin: typeof parsed.remoteCodexBin === "string" ? parsed.remoteCodexBin : "",
      remoteLabel: typeof parsed.remoteLabel === "string" ? parsed.remoteLabel : ""
    };
  } catch { return {}; }
}

function secureHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");
}
function sendJson(response, status, value) { return send(response, status, "application/json; charset=utf-8", JSON.stringify(value)); }
function send(response, status, type, body) { response.writeHead(status, { "Content-Type": type }); response.end(body); }
function emptySnapshot() {
  return {
    generatedAt: Date.now(), quotaAvailable: false, quota: null, activityAvailable: false, activityStale: false,
    remoteConfigured: Boolean(REMOTE_SSH_HOST),
    activitySources: { personal: { available: false, stale: false }, company: { available: false, stale: false } },
    hostLabels: { personal: LOCAL_MACHINE_LABEL, company: companyMachineLabel },
    tasks: [], taskCounts: { personal: 0, company: 0, all: 0 }
  };
}
