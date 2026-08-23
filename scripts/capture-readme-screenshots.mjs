import { createServer } from "node:http";
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const webRoot = join(projectRoot, "web");
const outputRoot = process.env.CODEX_PHONE_SCREENSHOT_OUTPUT || join(projectRoot, "assets", "readme", "phone");
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
  const routes = { "/": "index.html", "/app.js": "app.js", "/task-order.js": "task-order.js", "/styles.css": "styles.css", "/assets/progress-mascot.gif": "assets/progress-mascot.gif" };
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
const runnerPositions = new Map();

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
      await page.addStyleTag({ content: ".reset-arrows span,.progress-mascot{animation-play-state:paused!important}" });
      const visualState = await page.evaluate(() => {
        const barRect = document.querySelector(".bar").getBoundingClientRect();
        const mascotRect = document.querySelector(".progress-mascot").getBoundingClientRect();
        const runnerRect = document.querySelector("#reset-runner").getBoundingClientRect();
        const laneRect = document.querySelector(".reset-runner-lane").getBoundingClientRect();
        const arrowRect = document.querySelector("#reset-arrows").getBoundingClientRect();
        const arrowTextRect = document.querySelector("#reset-arrows span").getBoundingClientRect();
        const countdownRect = document.querySelector("#reset-countdown").getBoundingClientRect();
        const arrowsOverlapCountdown = arrowRect.left < countdownRect.right && arrowRect.right > countdownRect.left && arrowRect.top < countdownRect.bottom && arrowRect.bottom > countdownRect.top;
        return {
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          language: document.documentElement.lang,
          theme: document.body.dataset.quotaTheme,
          taskCount: document.querySelectorAll(".task").length,
          offline: document.querySelector("#connection").classList.contains("offline"),
          hosts: [...document.querySelectorAll("#host-filter button:not([hidden])")].map((button) => button.textContent.trim()),
          quotaFill: document.querySelector("#quota-fill").style.width,
          runnerHidden: document.querySelector("#reset-runner").hidden,
          arrowHidden: document.querySelector("#reset-arrows").hidden,
          countdown: document.querySelector("#reset-countdown").textContent.trim(),
          labelSide: document.querySelector("#reset-runner").dataset.labelSide,
          mascotLoaded: document.querySelector(".progress-mascot").complete && document.querySelector(".progress-mascot").naturalWidth > 0,
          runnerGap: Math.round(countdownRect.left - mascotRect.right),
          runnerRatio: (runnerRect.left - laneRect.left) / laneRect.width,
          mascotCentered: Math.abs(((mascotRect.left + mascotRect.right) / 2) - runnerRect.left) <= .5,
          mascotInsideBar: mascotRect.left >= barRect.left - .5 && mascotRect.right <= barRect.right + .5,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
          runnerLeft: Math.round(runnerRect.left),
          runnerRight: Math.round(runnerRect.right),
          arrowLeft: arrowRect.left,
          arrowRight: arrowRect.right,
          arrowWidth: arrowRect.width,
          mascotLeft: mascotRect.left,
          arrowsStartAtBar: Math.abs(arrowRect.left - barRect.left) <= .5,
          arrowsStopBeforeMascot: mascotRect.left - arrowRect.right >= 2.5 && mascotRect.left - arrowRect.right <= 4.5,
          arrowsAvoidMascot: arrowRect.right <= mascotRect.left - 2.5,
          arrowsAvoidCountdown: !arrowsOverlapCountdown,
          arrowTextCoversClip: arrowTextRect.right >= arrowRect.right,
          shellRight: Math.round(document.querySelector(".shell").getBoundingClientRect().right)
        };
      });
      const expectedTheme = state.remaining < 15 ? "danger" : state.remaining < 50 ? "warning" : "healthy";
      const expectedCountdown = language === "en" ? "120h until reset" : "还有 120 小时重置";
      const baselineRunnerLeft = runnerPositions.get(language);
      if (baselineRunnerLeft === undefined) runnerPositions.set(language, visualState.runnerLeft);
      if (visualState.overflow || visualState.language !== language || visualState.theme !== expectedTheme || visualState.taskCount !== 7 || visualState.offline !== state.offline || visualState.hosts.length !== 3 || visualState.quotaFill !== `${state.remaining}%` || visualState.runnerHidden || visualState.arrowHidden || visualState.countdown !== expectedCountdown || visualState.labelSide !== "after" || !visualState.mascotLoaded || visualState.runnerGap !== 0 || Math.abs(visualState.runnerRatio - (5 / 7)) > .01 || !visualState.mascotCentered || !visualState.mascotInsideBar || !visualState.arrowsStartAtBar || !visualState.arrowsStopBeforeMascot || !visualState.arrowsAvoidMascot || !visualState.arrowsAvoidCountdown || !visualState.arrowTextCoversClip || (baselineRunnerLeft !== undefined && visualState.runnerLeft !== baselineRunnerLeft) || errors.length) {
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
  await validateResetRunnerMotion(browser, port);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log(`Created 8 screenshots in ${outputRoot}`);

async function validateResetRunnerMotion(browser, port) {
  const positions = [];
  for (const resetHours of [168, 120, 24, 0]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: "en" });
    await context.route("**/api/snapshot", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture(95, resetHours)) }));
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/?lang=en`, { waitUntil: "domcontentloaded" });
    await page.locator("#dashboard:not([hidden])").waitFor();
    positions.push(await page.evaluate((hours) => {
      const barRect = document.querySelector(".bar").getBoundingClientRect();
      const runnerRect = document.querySelector("#reset-runner").getBoundingClientRect();
      const laneRect = document.querySelector(".reset-runner-lane").getBoundingClientRect();
      const mascotRect = document.querySelector(".progress-mascot").getBoundingClientRect();
      const countdownRect = document.querySelector("#reset-countdown").getBoundingClientRect();
      const arrowRect = document.querySelector("#reset-arrows").getBoundingClientRect();
      const arrowTextRect = document.querySelector("#reset-arrows span").getBoundingClientRect();
      const arrowsOverlapCountdown = arrowRect.left < countdownRect.right && arrowRect.right > countdownRect.left && arrowRect.top < countdownRect.bottom && arrowRect.bottom > countdownRect.top;
      return {
        resetHours: hours,
        expectedRatio: hours / 168,
        actualRatio: (runnerRect.left - laneRect.left) / laneRect.width,
        laneUsesFullBar: Math.abs(laneRect.left - barRect.left - 22.5) <= .5 && Math.abs(barRect.right - laneRect.right - 22.5) <= .5,
        mascotCentered: Math.abs(((mascotRect.left + mascotRect.right) / 2) - runnerRect.left) <= .5,
        mascotInsideBar: mascotRect.left >= barRect.left - .5 && mascotRect.right <= barRect.right + .5,
        arrowsStartAtBar: Math.abs(arrowRect.left - barRect.left) <= .5,
        arrowsStopBeforeMascot: hours === 0 ? arrowRect.width <= .5 : mascotRect.left - arrowRect.right >= 2.5 && mascotRect.left - arrowRect.right <= 4.5,
        arrowsAvoidMascot: hours === 0 || arrowRect.right <= mascotRect.left - 2.5,
        arrowsAvoidCountdown: !arrowsOverlapCountdown,
        arrowTextCoversClip: hours === 0 || arrowTextRect.right >= arrowRect.right,
        labelSide: document.querySelector("#reset-runner").dataset.labelSide,
        countdownInsideBar: countdownRect.left >= barRect.left && countdownRect.right <= barRect.right
      };
    }, resetHours));
    await context.close();
  }
  if (!positions.every((position) => Math.abs(position.actualRatio - position.expectedRatio) <= .01 && position.laneUsesFullBar && position.mascotCentered && position.mascotInsideBar && position.arrowsStartAtBar && position.arrowsStopBeforeMascot && position.arrowsAvoidMascot && position.arrowsAvoidCountdown && position.arrowTextCoversClip && position.countdownInsideBar) || positions[0].labelSide !== "before" || positions[1].labelSide !== "after") {
    throw new Error(`Reset runner did not use the full quota-bar time scale: ${JSON.stringify(positions)}`);
  }
}

function fixture(remaining, resetHours = 120) {
  return {
    generatedAt: now,
    remoteConfigured: true,
    quotaAvailable: true,
    quota: { windows: [{ name: "7 天", usedPercent: 100 - remaining, resetsAt: (now + resetHours * 60 * 60 * 1000) / 1000, windowDurationMins: 10080 }], stale: false },
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
