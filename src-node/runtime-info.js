import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function createRuntimeInfo({ pairingCode, pairingExpiresAt, port, addresses, processId }) {
  if (!/^\d{6}$/.test(pairingCode)) throw new Error("Pairing code must contain six digits");
  if (!Number.isFinite(pairingExpiresAt) || !Number.isInteger(port) || port <= 0 || !Number.isInteger(processId)) {
    throw new Error("Runtime info contains invalid values");
  }
  return {
    pairingCode,
    pairingExpiresAt,
    urls: addresses.map((address) => `http://${address}:${port}`),
    processId
  };
}

export async function writeRuntimeInfo(info, target = defaultRuntimeInfoPath()) {
  if (!target) return false;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(info, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return true;
}

function defaultRuntimeInfoPath() {
  if (process.env.CODEX_PHONE_RUNTIME_PATH) return process.env.CODEX_PHONE_RUNTIME_PATH;
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "CodexPhoneDashboard", "runtime-info.json");
  if (process.env.HOME) return join(process.env.HOME, "Library", "Application Support", "CodexPhoneDashboard", "runtime-info.json");
  return null;
}
