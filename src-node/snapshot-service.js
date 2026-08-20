import { AppServerClient, parseQuota } from "./app-server-client.js";
import { readRolloutActivity } from "./rollout-observer.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RUNNING_FRESH_MS = 120 * 1000;
const PRIORITY = { running: 0, failed: 1, interrupted: 2, completed: 3 };
const PUBLIC_PRIORITY = { running: 0, failed: 1, interrupted: 2, idle: 3, notLoaded: 4, completed: 5, unknown: 6 };
const COMPANY_PRIORITY = { active: 0, idle: 1, notLoaded: 2 };
const PUBLIC_TASK_LIMIT_PER_HOST = 50;

export class SnapshotService {
  constructor({
    client = new AppServerClient(), observer = readRolloutActivity, companyClient = null, companyObserver = null,
    personalLabel = "personal", companyLabel = "company", now = () => Date.now()
  } = {}) {
    this.client = client;
    this.observer = observer;
    this.companyClient = companyClient;
    this.companyObserver = companyObserver;
    this.personalLabel = personalLabel;
    this.companyLabel = companyLabel;
    this.now = now;
    this.lastQuota = null;
    this.lastTasks = null;
    this.lastCompanyTasks = null;
  }

  async refresh() {
    const now = this.now();
    const [quotaResult, threadResult, activityResult, companyResult, companyActivityResult] = await Promise.allSettled([
      this.client.readQuota(), this.client.readThreads(), this.observer({ now }),
      this.companyClient ? this.companyClient.readThreads() : Promise.resolve(null),
      this.companyObserver ? this.companyObserver({ now }) : Promise.resolve(null)
    ]);

    let quota = this.lastQuota ? { ...this.lastQuota, stale: true } : null;
    if (quotaResult.status === "fulfilled") {
      try {
        quota = parseQuota(quotaResult.value);
        this.lastQuota = quota;
      } catch {}
    }

    let taskView = this.lastTasks ? { ...this.lastTasks, stale: true } : { available: false, stale: false, tasks: [], totalCount: 0 };
    if (threadResult.status === "fulfilled" && activityResult.status === "fulfilled" && activityResult.value.available) {
      taskView = buildTasks(threadResult.value, activityResult.value.events, now);
      this.lastTasks = taskView;
    }

    let companyView = this.lastCompanyTasks
      ? { ...this.lastCompanyTasks, stale: true }
      : { available: false, stale: false, tasks: [], totalCount: 0 };
    if (this.companyClient && companyResult.status === "fulfilled" && companyActivityResult.status === "fulfilled" && companyActivityResult.value?.available) {
      companyView = buildTasks(companyResult.value, companyActivityResult.value.events, now);
      this.lastCompanyTasks = companyView;
    } else if (this.companyClient && companyResult.status === "fulfilled" && !this.lastCompanyTasks) {
      companyView = buildCompanyTasks(companyResult.value, now);
      this.lastCompanyTasks = companyView;
    }

    const personalTasks = taskView.tasks.map(({ title, state, at }) => ({ title, state, host: "personal", at }));
    const companyTasks = companyView.tasks.map(({ title, state, at }) => ({ title, state, host: "company", at }));
    const tasks = [...personalTasks, ...companyTasks]
      .sort((a, b) => (PUBLIC_PRIORITY[a.state] - PUBLIC_PRIORITY[b.state]) || (b.at - a.at))
      .map(({ title, state, host }) => ({ title, state, host }));

    return {
      generatedAt: now,
      remoteConfigured: Boolean(this.companyClient),
      quotaAvailable: Boolean(quota),
      quota,
      activityAvailable: taskView.available || companyView.available,
      activityStale: taskView.stale || companyView.stale,
      activitySources: {
        personal: { available: taskView.available, stale: taskView.stale },
        company: { available: companyView.available, stale: companyView.stale }
      },
      hostLabels: {
        personal: resolveLabel(this.personalLabel, "personal"),
        company: resolveLabel(this.companyLabel, "company")
      },
      tasks,
      taskCounts: {
        personal: taskView.totalCount,
        company: companyView.totalCount,
        all: taskView.totalCount + companyView.totalCount
      }
    };
  }
}

function resolveLabel(value, fallback) {
  const resolved = typeof value === "function" ? value() : value;
  const label = String(resolved || "").trim().replace(/\.local$/i, "");
  return label ? label.slice(0, 40) : fallback;
}

export function buildTasks(threads, events, now = Date.now()) {
  const byId = new Map();
  for (const thread of threads) {
    if (thread.id) byId.set(thread.id, thread);
    if (thread.sessionId) byId.set(thread.sessionId, thread);
  }
  const folded = new Map();
  for (const event of events) {
    let thread = byId.get(event.sessionId);
    if (!thread) continue;
    if (thread.parentThreadId) thread = byId.get(thread.parentThreadId) || thread;
    if (event.state === "running" && now - event.at > RUNNING_FRESH_MS) continue;
    if (event.state !== "running" && now - event.at > DAY_MS) continue;
    const key = thread.id || thread.sessionId;
    const current = folded.get(key);
    if (!current || event.at > current.at) {
      folded.set(key, { title: thread.title, state: event.state, at: event.at });
    }
  }
  const all = [...folded.values()].sort((a, b) => (PRIORITY[a.state] - PRIORITY[b.state]) || (b.at - a.at));
  return { available: true, stale: false, tasks: all.slice(0, PUBLIC_TASK_LIMIT_PER_HOST), totalCount: all.length };
}

export function buildCompanyTasks(threads, now = Date.now()) {
  const all = threads
    .filter((thread) => !thread.parentThreadId)
    .filter((thread) => thread.appStatus === "active" || (thread.updatedAt && now - thread.updatedAt <= DAY_MS))
    .map((thread) => ({
      title: thread.title,
      state: ({ active: "running", idle: "idle", notLoaded: "notLoaded" })[thread.appStatus] || "notLoaded",
      status: thread.appStatus || "notLoaded",
      at: thread.updatedAt || 0
    }))
    .sort((a, b) => (COMPANY_PRIORITY[a.status] - COMPANY_PRIORITY[b.status]) || (b.at - a.at));
  return { available: true, stale: false, tasks: all.slice(0, PUBLIC_TASK_LIMIT_PER_HOST), totalCount: all.length };
}
