import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export async function loadOrCreateSessionSecret(target = defaultAuthStatePath()) {
  if (!target) throw new Error("Unable to resolve the local authentication state path");
  try {
    const stored = JSON.parse(await readFile(target, "utf8"));
    if (isValidSecret(stored?.sessionSecret)) return stored.sessionSecret;
  } catch {}
  return rotateSessionSecret(target);
}

export async function rotateSessionSecret(target = defaultAuthStatePath()) {
  if (!target) throw new Error("Unable to resolve the local authentication state path");
  const sessionSecret = randomBytes(32).toString("base64url");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ version: 1, sessionSecret }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(target, 0o600);
  return sessionSecret;
}

export function createSessionCookie(sessionSecret) {
  if (!isValidSecret(sessionSecret)) throw new Error("Invalid session secret");
  return `codex_phone_session=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function isSessionAuthenticated(cookieHeader, sessionSecret) {
  if (!isValidSecret(sessionSecret)) return false;
  const match = String(cookieHeader || "").match(/(?:^|;\s*)codex_phone_session=([^;]+)/);
  return match ? safeEqual(match[1], sessionSecret) : false;
}

export function defaultAuthStatePath() {
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "CodexPhoneDashboard", "auth-state.json");
  if (process.env.HOME) return join(process.env.HOME, "Library", "Application Support", "CodexPhoneDashboard", "auth-state.json");
  return null;
}

function isValidSecret(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
