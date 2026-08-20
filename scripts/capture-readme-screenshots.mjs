import { createServer } from "node:http";
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const webRoot = join(projectRoot, "web");
const outputRoot = join(projectRoot, "assets", "readme", "phone");
const now = Date.parse("2026-08-20T18:00:00Z");
const browserPath = await findBrowser();

const tasks = [
  ["Polish the onboarding guide", "running", "personal"],
  ["Verify quota refresh behavior", "completed", "company"],
  ["Add bilingual labels", "completed", "personal"],
  ["Test the private Wi-Fi connection", "completed", "company"],
  ["Review mobile spacing", "completed", "personal"],
  ["Check privacy mode", "completed", "company"],
  ["Prepare release screenshots", "completed", "personal"],
  ["Validate the install skill", "completed", "company"],
  ["Write troubleshooting notes", "completed", "personal"]
].map(([title, state, host]) => ({ title, state, host }));

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/api/session") return json(response, { authenticated: true });
  if (url.pathname === "/api/snapshot") return json(response, fixture(Number(url.searchParams.get("remaining") || 95)));
  if (url.pathname === "/events") {
    if (url.searchParams.get("offline") === "1") { response.writeHead(503); return response.end(); }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    return response.write(": connected\n\n");
  }
  const routes = { "/": "index.html", "/app.js": "app.js", "/styles.css": "styles.css", "/assets/progress-mascot.gif": "assets/progress-mascot.gif" };
  const file = routes[url.pathname];
  if (!file) { response.writeHead(404); return response.end(); }
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".gif": "image/gif" };
  response.writeHead(200, { "Content-Type": types[extname(file)], "Cache-Control": "no-store" });
  response.end(await readFile(join(webRoot, file)));
});

await new Promise((resolve) => server.listen(43119, "127.0.0.1", resolve));
const port = server.address().port;
await mkdir(outputRoot, { recursive: true });
const browser = await chromium.launch({ executablePath: browserPath, headless: true });

try {
  for (const language of ["zh-CN", "en"]) {
    for (const state of [
      { name: "connected-healthy-95", remaining: 95, offline: false },
      { name: "connected-warning-42", remaining: 42, offline: false },
      { name: "connected-danger-12", remaining: 12, offline: false },
      { name: "disconnected", remaining: 95, offline: true }
    ]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: language });
      await context.route("**/api/snapshot", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture(state.remaining)) }));
      if (state.offline) await context.route("**/events", (route) => route.fulfill({ status: 503, body: "offline" }));
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/?lang=${language}`, { waitUntil: "domcontentloaded" });
      await page.locator("#dashboard:not([hidden])").waitFor();
      await page.waitForTimeout(state.offline ? 350 : 150);
      const visualState = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        language: document.documentElement.lang,
        theme: document.body.dataset.quotaTheme,
        taskCount: document.querySelectorAll(".task").length,
        offline: document.querySelector("#connection").classList.contains("offline"),
        hosts: [...document.querySelectorAll("#host-filter button:not([hidden])")].map((button) => button.textContent.trim())
      }));
      const expectedTheme = state.remaining < 15 ? "danger" : state.remaining < 50 ? "warning" : "healthy";
      if (visualState.overflow || visualState.language !== language || visualState.theme !== expectedTheme || visualState.taskCount !== 7 || visualState.offline !== state.offline || visualState.hosts.length !== 3 || errors.length) {
        throw new Error(`Visual verification failed for ${language}/${state.name}: ${JSON.stringify(visualState)}; ${errors.join("; ")}`);
      }
      if (state.name === "connected-healthy-95") {
        await page.locator("#language-toggle").click();
        if (await page.getAttribute("html", "lang") === language) throw new Error(`Language toggle did not change ${language}.`);
        await page.locator("#language-toggle").click();
      }
      await page.screenshot({ path: join(outputRoot, `dashboard-${language === "en" ? "en" : "zh"}-${state.name}.png`), fullPage: false });
      await context.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log(`Created 8 screenshots in ${outputRoot}`);

function fixture(remaining) {
  return {
    generatedAt: now,
    remoteConfigured: true,
    quotaAvailable: true,
    quota: { windows: [{ name: "7 天", usedPercent: 100 - remaining, resetsAt: (now + 7 * 24 * 60 * 60 * 1000) / 1000 }], stale: false },
    activityAvailable: true,
    activityStale: false,
    activitySources: { personal: { available: true, stale: false }, company: { available: true, stale: false } },
    hostLabels: { personal: "STUDIO-PC", company: "TRAVEL-MAC" },
    tasks,
    taskCounts: { personal: 5, company: 4, all: 9 }
  };
}

function json(response, value) {
  response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function findBrowser() {
  const candidates = process.platform === "win32"
    ? [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
    : process.platform === "darwin"
      ? [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium"];
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error(`Chrome or Edge was not found on ${hostname()}. Set CHROME_PATH and retry.`);
}
