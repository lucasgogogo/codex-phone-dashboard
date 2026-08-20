const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TASK_LIMIT = 7;
const COMPLETION_FLASH_MS = 1600;

const TEXT = {
  "zh-CN": {
    firstConnection: "首次连接", enterPairingCode: "输入电脑显示的 6 位配对码",
    pairingHelp: "配对成功后，这台手机会保持登录 12 小时。", pairingCode: "配对码",
    connectComputer: "连接电脑", disconnected: "连接中断", connected: "已连接",
    codexStatus: "CODEX 状态", availableQuota: "可用额度", staleData: "旧数据",
    quotaUnavailable: "暂时读不到 Codex 额度。", recentTasks: "最近任务", hideTitles: "隐藏标题",
    allHosts: "全部", loadingTasks: "正在读取任务状态…", notSynced: "尚未同步",
    wifiReadonly: "同一 Wi-Fi · 只读", pairingFailed: "配对失败", pairingExpired: "配对码已过期，请重启服务",
    tooManyAttempts: "尝试次数过多，请稍后再试", requestTooLarge: "请求过大", pairingIncorrect: "配对码不正确", hubUnavailable: "无法连接本地 Hub",
    privateTask: "隐私任务", noTasks: "24 小时内暂无可显示的任务。", sourceUnavailable: "任务源暂时不可用。",
    stalePrefix: "旧数据 · ", syncedAt: "同步于 {time}", quotaReset: "{name}额度 · {time} 重置",
    dailyAvailable: "接下来平均每日可用 {value}%", collapseTasks: "收起任务",
    moreTasks: "另有 {count} 个最近任务，点击展开",
    states: { running: "运行中", completed: "已完成", failed: "失败", interrupted: "已中断", idle: "空闲", notLoaded: "未加载", unknown: "未知" }
  },
  en: {
    firstConnection: "FIRST CONNECTION", enterPairingCode: "Enter the 6-digit code shown on your computer",
    pairingHelp: "After pairing, this phone stays signed in for 12 hours.", pairingCode: "Pairing code",
    connectComputer: "Connect computer", disconnected: "Disconnected", connected: "Connected",
    codexStatus: "CODEX STATUS", availableQuota: "Available quota", staleData: "Stale",
    quotaUnavailable: "Codex quota is temporarily unavailable.", recentTasks: "Recent tasks", hideTitles: "Hide titles",
    allHosts: "All", loadingTasks: "Loading task status…", notSynced: "Not synced yet",
    wifiReadonly: "Same Wi-Fi · Read only", pairingFailed: "Pairing failed", pairingExpired: "Pairing code expired. Restart the service.",
    tooManyAttempts: "Too many attempts. Try again shortly.", requestTooLarge: "Request is too large.", pairingIncorrect: "Pairing code is incorrect.", hubUnavailable: "Cannot reach the local hub",
    privateTask: "Private task", noTasks: "No displayable tasks in the last 24 hours.", sourceUnavailable: "Task source is temporarily unavailable.",
    stalePrefix: "Stale · ", syncedAt: "Synced {time}", quotaReset: "{name} quota · resets {time}",
    dailyAvailable: "Average daily allowance {value}%", collapseTasks: "Collapse tasks",
    moreTasks: "{count} more recent tasks · tap to expand",
    states: { running: "Running", completed: "Completed", failed: "Failed", interrupted: "Interrupted", idle: "Idle", notLoaded: "Not loaded", unknown: "Unknown" }
  }
};

const $ = (selector) => document.querySelector(selector);
const pairing = $("#pairing");
const dashboard = $("#dashboard");
const pairForm = $("#pair-form");
const pairError = $("#pair-error");
const connection = $("#connection");
const hubLabel = $("#hub-label");
const languageToggle = $("#language-toggle");
const themeColor = $("#theme-color");
const quotaContent = $("#quota-content");
const quotaEmpty = $("#quota-empty");
const quotaStale = $("#quota-stale");
const quotaNumber = $("#quota-number");
const quotaFill = $("#quota-fill");
const barArea = $("#bar-area");
const quotaReset = $("#quota-reset");
const quotaDaily = $("#quota-daily");
const taskList = $("#task-list");
const taskEmpty = $("#task-empty");
const moreTasks = $("#more-tasks");
const lastSync = $("#last-sync");
const privacy = $("#privacy");
const hostFilter = $("#host-filter");

const requestedLanguage = new URLSearchParams(location.search).get("lang");
let language = requestedLanguage === "en" || requestedLanguage === "zh-CN"
  ? requestedLanguage
  : localStorage.getItem("codex-phone-language") || (navigator.language.startsWith("zh") ? "zh-CN" : "en");
let latest = null;
let stream = null;
let expanded = false;
let completionFlashKey = null;
let completionFlashTimer = null;
const completionPromotions = new Map();
let selectedHost = localStorage.getItem("codex-phone-host-filter") || "all";
if (!["all", "company", "personal"].includes(selectedHost)) selectedHost = "all";

function t(key, values = {}) {
  let value = TEXT[language][key] ?? TEXT["zh-CN"][key] ?? key;
  for (const [name, replacement] of Object.entries(values)) value = value.replace(`{${name}}`, replacement);
  return value;
}

function applyLanguage() {
  document.documentElement.lang = language;
  document.title = language === "en" ? "Codex Phone Dashboard" : "Codex 手机状态屏";
  languageToggle.textContent = language === "en" ? "中" : "EN";
  languageToggle.setAttribute("aria-label", language === "en" ? "切换到中文" : "Switch to English");
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  if (latest) render();
}

languageToggle.addEventListener("click", () => {
  language = language === "en" ? "zh-CN" : "en";
  localStorage.setItem("codex-phone-language", language);
  applyLanguage();
});

privacy.checked = localStorage.getItem("codex-phone-privacy") === "1";
privacy.addEventListener("change", () => { localStorage.setItem("codex-phone-privacy", privacy.checked ? "1" : "0"); render(); });

hostFilter.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-host]");
  if (!button) return;
  selectedHost = button.dataset.host;
  expanded = false;
  localStorage.setItem("codex-phone-host-filter", selectedHost);
  render();
});

moreTasks.addEventListener("click", () => { expanded = !expanded; render(); });

pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  pairError.textContent = "";
  const pin = new FormData(pairForm).get("pin");
  try {
    const response = await fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
    const result = await response.json();
    if (!response.ok) throw new Error(t(result.errorCode || "pairingFailed"));
    await connect();
  } catch (error) { pairError.textContent = error.message; }
});

async function connect() {
  const session = await fetch("/api/session");
  const status = await session.json();
  if (!status.authenticated) return showPairing();
  const response = await fetch("/api/snapshot");
  if (!response.ok) throw new Error(t("hubUnavailable"));
  showDashboard();
  acceptSnapshot(await response.json());
  openEvents();
}

function openEvents() {
  if (stream) stream.close();
  stream = new EventSource("/events");
  stream.addEventListener("snapshot", (event) => acceptSnapshot(JSON.parse(event.data)));
  stream.onopen = () => setConnection(true);
  stream.onerror = () => setConnection(false);
}

function acceptSnapshot(data) {
  detectCompletedTransitions(latest?.tasks || [], data.tasks || [], Boolean(latest));
  latest = data;
  render();
}

function detectCompletedTransitions(previousTasks, nextTasks, hasPreviousSnapshot) {
  const previous = new Map(previousTasks.map((item) => [taskKey(item), item.state]));
  const nextKeys = new Set(nextTasks.map(taskKey));
  for (const key of completionPromotions.keys()) if (!nextKeys.has(key)) completionPromotions.delete(key);
  for (const item of nextTasks) {
    const key = taskKey(item);
    const oldState = previous.get(key);
    if (item.state !== "completed") { completionPromotions.delete(key); continue; }
    if ((oldState && oldState !== "completed") || (hasPreviousSnapshot && !oldState)) {
      completionPromotions.set(key, Date.now());
      completionFlashKey = key;
      clearTimeout(completionFlashTimer);
      completionFlashTimer = setTimeout(() => { if (completionFlashKey === key) completionFlashKey = null; render(); }, COMPLETION_FLASH_MS);
    }
  }
}

function render() {
  if (!latest) return;
  renderHostLabels();
  renderQuota();
  renderTasks();
  const stale = selectedHost === "all" ? latest.activityStale : latest.activitySources?.[selectedHost]?.stale;
  lastSync.textContent = `${stale ? t("stalePrefix") : ""}${t("syncedAt", { time: formatTime(latest.generatedAt) })}`;
  setConnection(true);
}

function renderHostLabels() {
  const personal = hostName("personal");
  const company = hostName("company");
  hubLabel.textContent = `${personal} HUB · LOCAL ONLY`;
  const personalButton = hostFilter.querySelector('[data-host="personal"]');
  const companyButton = hostFilter.querySelector('[data-host="company"]');
  personalButton.textContent = personal;
  companyButton.textContent = company;
  personalButton.title = personal;
  companyButton.title = company;
  companyButton.hidden = !latest.remoteConfigured && !(latest.tasks || []).some((item) => item.host === "company");
  if (companyButton.hidden && selectedHost === "company") selectedHost = "all";
  hostFilter.querySelector('[data-host="all"]').textContent = t("allHosts");
  for (const button of hostFilter.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.host === selectedHost));
}

function renderQuota() {
  const item = selectQuotaWindow(latest.quota?.windows || []);
  quotaEmpty.hidden = Boolean(item);
  quotaContent.hidden = !item;
  quotaStale.hidden = !latest.quota?.stale;
  if (!item) return applyTheme("healthy");
  const remaining = clamp(100 - Number(item.usedPercent || 0), 0, 100);
  const resetAt = Number(item.resetsAt) * 1000;
  const daysRemaining = Math.max(1, Math.ceil((resetAt - Number(latest.generatedAt || Date.now())) / DAY_MS));
  const daily = remaining / daysRemaining;
  quotaNumber.textContent = formatQuota(remaining);
  quotaFill.style.width = `${remaining}%`;
  barArea.style.setProperty("--progress", `${remaining}%`);
  quotaReset.textContent = t("quotaReset", { name: localizedWindowName(item.name), time: formatReset(resetAt) });
  quotaDaily.textContent = t("dailyAvailable", { value: daily.toFixed(1) });
  applyTheme(remaining < 15 ? "danger" : remaining < 50 ? "warning" : "healthy");
}

function renderTasks() {
  const oldPositions = new Map([...taskList.children].map((node) => [node.dataset.key, node.getBoundingClientRect().top]));
  const source = latest.activitySources?.[selectedHost];
  const available = selectedHost === "all" ? latest.activityAvailable : source?.available;
  const filtered = (latest.tasks || []).filter((item) => selectedHost === "all" || item.host === selectedHost);
  const sorted = filtered.map((item, index) => ({ item, index, promotedAt: completionPromotions.get(taskKey(item)) || 0 }))
    .sort((left, right) => (right.promotedAt - left.promotedAt) || (left.index - right.index)).map(({ item }) => item);
  const visibleTasks = expanded ? sorted : sorted.slice(0, DEFAULT_TASK_LIMIT);
  const totalCount = latest.taskCounts?.[selectedHost] ?? sorted.length;
  taskList.replaceChildren();
  taskEmpty.hidden = available && visibleTasks.length > 0;
  taskEmpty.textContent = available ? t("noTasks") : `${selectedHost === "all" ? "" : `${hostName(selectedHost)} · `}${t("sourceUnavailable")}`;
  for (const item of visibleTasks) {
    const key = taskKey(item);
    const row = element("article", `task ${item.state}${key === completionFlashKey ? " completion-flash" : ""}`);
    row.dataset.key = key;
    const detail = element("div", "task-detail");
    detail.append(element("p", "task-title", privacy.checked ? t("privateTask") : item.title), element("span", "host-badge", hostName(item.host)));
    row.append(element("span", "task-dot"), detail, element("span", "task-state", stateName(item.state)));
    taskList.append(row);
  }
  requestAnimationFrame(() => animateReorder(oldPositions));
  const hiddenCount = Math.max(0, totalCount - DEFAULT_TASK_LIMIT);
  moreTasks.hidden = hiddenCount === 0;
  moreTasks.setAttribute("aria-expanded", String(expanded));
  moreTasks.textContent = expanded ? t("collapseTasks") : t("moreTasks", { count: hiddenCount });
}

function animateReorder(oldPositions) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const row of taskList.children) {
    const oldTop = oldPositions.get(row.dataset.key);
    if (oldTop === undefined) continue;
    const delta = oldTop - row.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) continue;
    row.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
}

function applyTheme(theme) {
  document.body.dataset.quotaTheme = theme;
  themeColor.content = ({ healthy: "#07100d", warning: "#120f07", danger: "#130b0b" })[theme];
}
function selectQuotaWindow(windows) { return windows.find((item) => /7\s*(天|day)/i.test(item.name)) || windows.at(-1) || null; }
function localizedWindowName(value) {
  const days = String(value).match(/^(\d+)\s*天$/);
  const hours = String(value).match(/^(\d+)\s*小时$/);
  if (language === "en" && days) return `${days[1]}-day`;
  if (language === "en" && hours) return `${hours[1]}-hour`;
  return value;
}
function hostName(host) { return String(latest?.hostLabels?.[host] || ({ personal: "LOCAL", company: "REMOTE" })[host] || host).replace(/\.local$/i, ""); }
function taskKey(item) { return `${item.host}\u0000${item.title}`; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function formatQuota(value) { return Number.isInteger(value) ? String(value) : value.toFixed(1); }
function element(tag, className, text) { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; }
function stateName(value) { return TEXT[language].states[value] || TEXT[language].states.unknown; }
function formatTime(value) { return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatReset(value) { return new Intl.DateTimeFormat(language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
function setConnection(online) {
  connection.classList.toggle("online", online);
  connection.classList.toggle("offline", !online);
  connection.querySelector("b").textContent = online ? t("connected") : t("disconnected");
}
function showPairing() { pairing.hidden = false; dashboard.hidden = true; setConnection(false); }
function showDashboard() { pairing.hidden = true; dashboard.hidden = false; }

applyLanguage();
connect().catch(showPairing);
