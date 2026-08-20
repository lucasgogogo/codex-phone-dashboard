import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQuota, parseThreadPage } from "../src-node/app-server-client.js";
import { parseRollout } from "../src-node/rollout-observer.js";
import { parseRemoteActivity } from "../src-node/remote-rollout-observer.js";
import { createRuntimeInfo, writeRuntimeInfo } from "../src-node/runtime-info.js";
import { buildCompanyTasks, buildTasks, SnapshotService } from "../src-node/snapshot-service.js";
import { sortTasksForDisplay } from "../web/task-order.js";

test("quota parser exposes only normalized usage fields", () => {
  const quota = parseQuota({
    rateLimits: {
      primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 2_000_000_000 },
      secondary: { usedPercent: 51, windowDurationMins: 10080, resetsAt: 2_000_000_001 }
    },
    rateLimitResetCredits: { availableCount: 2 }
  });
  assert.deepEqual(quota.windows.map(({ name, usedPercent }) => ({ name, usedPercent })), [
    { name: "5 小时", usedPercent: 23 }, { name: "7 天", usedPercent: 51 }
  ]);
  assert.equal(quota.resetCredits, 2);
});

test("thread parser keeps metadata and drops preview and cwd", () => {
  const page = parseThreadPage({ data: [{
    id: "task-1", sessionId: "session-1", name: "Dashboard task", parentThreadId: null,
    source: "appServer", status: { type: "active" }, updatedAt: 1_777_000_000,
    preview: "private reply", cwd: "C:/private/path"
  }], nextCursor: null });
  assert.deepEqual(Object.keys(page.tasks[0]).sort(), ["appStatus", "id", "parentThreadId", "sessionId", "source", "title", "updatedAt"]);
  assert.equal(page.tasks[0].appStatus, "active");
  assert.equal(page.tasks[0].updatedAt, 1_777_000_000_000);
  assert.equal(JSON.stringify(page).includes("private reply"), false);
  assert.equal(JSON.stringify(page).includes("private/path"), false);
});

test("rollout parser reads lifecycle fields without message content", async () => {
  const folder = await mkdtemp(join(tmpdir(), "codex-phone-"));
  const file = join(folder, "rollout.jsonl");
  await writeFile(file, [
    JSON.stringify({ type: "session_meta", payload: { id: "session-1", cwd: "private" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", started_at: "2026-08-20T12:00:00Z", prompt: "private" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", completed_at: "2026-08-20T12:01:00Z", last_agent_message: "private" } })
  ].join("\n"), "utf8");
  const result = await parseRollout(file);
  assert.deepEqual(result, { sessionId: "session-1", state: "completed", at: Date.parse("2026-08-20T12:01:00Z") });
});

test("personal task reducer folds subagents and retains safe candidates for browser filtering", () => {
  const now = Date.parse("2026-08-20T12:02:00Z");
  const threads = [
    { id: "parent", sessionId: "p", title: "Parent", parentThreadId: null },
    { id: "child", sessionId: "c", title: "Child", parentThreadId: "parent" },
    { id: "two", sessionId: "2", title: "Two", parentThreadId: null },
    { id: "three", sessionId: "3", title: "Three", parentThreadId: null },
    { id: "four", sessionId: "4", title: "Four", parentThreadId: null }
  ];
  const events = [
    { sessionId: "c", state: "running", at: now - 1_000 },
    { sessionId: "2", state: "failed", at: now - 2_000 },
    { sessionId: "3", state: "completed", at: now - 3_000 },
    { sessionId: "4", state: "completed", at: now - 4_000 }
  ];
  const result = buildTasks(threads, events, now);
  assert.deepEqual(result.tasks.map((task) => task.title), ["Parent", "Two", "Three", "Four"]);
  assert.equal(result.totalCount, 4);
});

test("company task reducer uses app status, removes subagents, and limits history to one day", () => {
  const now = Date.parse("2026-08-20T12:02:00Z");
  const result = buildCompanyTasks([
    { title: "Active", parentThreadId: null, appStatus: "active", updatedAt: now - 200_000_000 },
    { title: "Idle", parentThreadId: null, appStatus: "idle", updatedAt: now - 1_000 },
    { title: "Old", parentThreadId: null, appStatus: "idle", updatedAt: now - 200_000_000 },
    { title: "Child", parentThreadId: "parent", appStatus: "active", updatedAt: now }
  ], now);
  assert.deepEqual(result.tasks.map(({ title, state }) => ({ title, state })), [
    { title: "Active", state: "running" }, { title: "Idle", state: "idle" }
  ]);
  assert.equal(result.totalCount, 2);
});

test("display ordering keeps running tasks ahead of newly completed promotions", () => {
  const tasks = [
    { title: "Newest completion", state: "completed" },
    { title: "Running older", state: "running" },
    { title: "Failed", state: "failed" },
    { title: "Running newer", state: "running" },
    { title: "Older completion", state: "completed" }
  ];
  const promotions = new Map([["Newest completion", 200], ["Older completion", 100]]);
  const result = sortTasksForDisplay(tasks, (item) => promotions.get(item.title));
  assert.deepEqual(result.map((item) => item.title), [
    "Running older", "Running newer", "Newest completion", "Older completion", "Failed"
  ]);
});

test("display ordering preserves backend order when no completion is promoted", () => {
  const tasks = [
    { title: "Running", state: "running" },
    { title: "Failed", state: "failed" },
    { title: "Interrupted", state: "interrupted" },
    { title: "Completed", state: "completed" }
  ];
  assert.deepEqual(sortTasksForDisplay(tasks).map((item) => item.title), tasks.map((item) => item.title));
});

test("remote activity parser keeps only lifecycle metadata", () => {
  const parsed = parseRemoteActivity(JSON.stringify({
    available: true,
    events: [{ sessionId: "safe-id", state: "running", at: 1234, prompt: "private" }, { sessionId: "bad", state: "waiting", at: 1235 }]
  }));
  assert.deepEqual(parsed, { available: true, events: [{ sessionId: "safe-id", state: "running", at: 1234 }] });
  assert.equal(JSON.stringify(parsed).includes("private"), false);
});

test("public snapshot exposes host labels but removes correlation ids and internal timestamps", async () => {
  const now = Date.parse("2026-08-20T12:02:00Z");
  const client = {
    readQuota: async () => ({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 2_000_000_000 } } }),
    readThreads: async () => [{ id: "secret-id", sessionId: "secret-session", title: "Visible title", parentThreadId: null }]
  };
  const observer = async () => ({ available: true, events: [{ sessionId: "secret-session", state: "completed", at: now - 1_000 }] });
  const companyClient = { readThreads: async () => [{
    id: "company-secret", sessionId: "company-session", title: "Company title", parentThreadId: null, appStatus: "notLoaded", updatedAt: now - 2_000
  }] };
  const companyObserver = async () => ({ available: true, events: [{ sessionId: "company-session", state: "running", at: now - 2_000 }] });
  const snapshot = await new SnapshotService({
    client, observer, companyClient, companyObserver,
    personalLabel: "STUDIO-PC", companyLabel: "TRAVEL-MAC.local", now: () => now
  }).refresh();
  assert.deepEqual(snapshot.tasks, [
    { title: "Company title", state: "running", host: "company" },
    { title: "Visible title", state: "completed", host: "personal" }
  ]);
  assert.deepEqual(snapshot.taskCounts, { personal: 1, company: 1, all: 2 });
  assert.deepEqual(snapshot.hostLabels, { personal: "STUDIO-PC", company: "TRAVEL-MAC" });
  assert.equal(JSON.stringify(snapshot).includes("secret-id"), false);
  assert.equal(JSON.stringify(snapshot).includes("secret-session"), false);
  assert.equal(JSON.stringify(snapshot).includes("company-secret"), false);
  assert.equal(JSON.stringify(snapshot).includes("company-session"), false);
  assert.equal(JSON.stringify(snapshot).includes(String(now - 2_000)), false);
});

test("dashboard UI includes bilingual quota states, seven-task expansion, hostname labels, completion motion, and copyright", async () => {
  const [html, script, styles, server] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src-node/server.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /© 2026 lucasgogogo/);
  assert.match(html, /progress-mascot\.gif/);
  assert.match(html, /id="quota-number"/);
  assert.match(html, /class="quota-symbol"/);
  assert.match(script, /DEFAULT_TASK_LIMIT = 7/);
  assert.match(script, /remaining < 15/);
  assert.match(script, /remaining < 50/);
  assert.match(script, /接下来平均每日可用/);
  assert.match(script, /Average daily allowance/);
  assert.match(script, /codex-phone-language/);
  assert.match(html, /id="language-toggle"/);
  assert.match(script, /hostLabels/);
  assert.match(script, /hasPreviousSnapshot/);
  assert.match(script, /remoteConfigured/);
  assert.match(styles, /completion-flash/);
  assert.match(styles, /task\.completed \.task-state/);
  assert.match(styles, /connection\.offline span::before/);
  assert.match(styles, /connection\.offline span::after/);
  assert.match(styles, /quota-number/);
  assert.match(styles, /quota-symbol/);
  assert.match(styles, /progressMascot/);
  assert.match(server, /CODEX_PHONE_REMOTE_SSH_HOST/);
  assert.doesNotMatch(server, /Content-Disposition/);
  assert.doesNotMatch(server, /Content-Disposition/);
});

test("remote monitoring is optional and disabled without an explicit SSH host", async () => {
  const [server, exampleConfig, gitignore] = await Promise.all([
    readFile(new URL("../src-node/server.js", import.meta.url), "utf8"),
    readFile(new URL("../config.example.json", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8")
  ]);
  assert.match(server, /REMOTE_SSH_HOST \? new AppServerClient/);
  assert.match(server, /remoteConfigured: Boolean\(REMOTE_SSH_HOST\)/);
  assert.equal(JSON.parse(exampleConfig).remoteSshHost, "");
  assert.match(gitignore, /^config\.local\.json$/m);
});

test("company outage keeps personal activity available and marks only company unavailable", async () => {
  const now = Date.parse("2026-08-20T12:02:00Z");
  const client = {
    readQuota: async () => ({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 2_000_000_000 } } }),
    readThreads: async () => [{ id: "p", sessionId: "p", title: "Personal", parentThreadId: null }]
  };
  const observer = async () => ({ available: true, events: [{ sessionId: "p", state: "running", at: now - 1_000 }] });
  const companyClient = { readThreads: async () => { throw new Error("offline"); } };
  const snapshot = await new SnapshotService({ client, observer, companyClient, now: () => now }).refresh();
  assert.equal(snapshot.activityAvailable, true);
  assert.deepEqual(snapshot.activitySources, {
    personal: { available: true, stale: false }, company: { available: false, stale: false }
  });
  assert.deepEqual(snapshot.tasks, [{ title: "Personal", state: "running", host: "personal" }]);
});

test("runtime status persists pairing details without task data", async () => {
  const folder = await mkdtemp(join(tmpdir(), "codex-phone-runtime-"));
  const target = join(folder, "runtime-info.json");
  const info = createRuntimeInfo({
    pairingCode: "123456", pairingExpiresAt: 2_000_000_000_000, port: 43117,
    addresses: ["192.168.50.20"], processId: 321
  });
  await writeRuntimeInfo(info, target);
  const stored = JSON.parse(await readFile(target, "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["pairingCode", "pairingExpiresAt", "processId", "urls"]);
  assert.equal(JSON.stringify(stored).includes("title"), false);
  assert.equal(JSON.stringify(stored).includes("state"), false);
  assert.equal(JSON.stringify(stored).includes("company"), false);
});
