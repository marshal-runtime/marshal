/** Persists the gateway-auth selection only — NOT the access token (acquired
 *  fresh per login via acquireWeaveToken). If we ever start persisting bearer
 *  tokens or refresh tokens here, migrate to safe-storage-file.ts first. */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { GatewayAuthIdentity, GatewayAuthMode } from "../../common/marshal-ipc-contract";
import { GATEWAY_AUTH_MODES, isGatewayRoleMode } from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import { secureWriteFileSync } from "../platform-security";

const log = createLogger("GatewayAuthStore");

export type GatewayAuthCred = GatewayAuthIdentity;

function getStorePath(): string {
  const dir = process.env.MARSHAL_GATEWAY_AUTH_DIR ?? path.join(os.homedir(), ".marshal");
  return path.join(dir, "marshal-gateway-auth.json");
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function isValidMode(value: string): value is GatewayAuthMode {
  return (GATEWAY_AUTH_MODES as ReadonlyArray<string>).includes(value);
}

export function loadGatewayAuthCred(): GatewayAuthCred | null {
  const file = getStorePath();
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    // SF-4: safeParseJson
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const obj = parsed as Record<string, unknown>;
    const { mode } = obj;
    if (typeof mode !== "string" || !isValidMode(mode)) {
      log.warn("Discarding on-disk cred with legacy mode:", mode);
      return null;
    }
    const cred: GatewayAuthCred = { mode };
    if (typeof obj.oid === "string") cred.oid = obj.oid;
    if (typeof obj.tid === "string") cred.tid = obj.tid;
    // Unknown roleMode strings are dropped rather than silently downgrading to
    // operator — a future enum value would otherwise lose its meaning on older clients.
    if (typeof obj.roleMode === "string" && isGatewayRoleMode(obj.roleMode)) {
      cred.roleMode = obj.roleMode;
    }
    if (typeof obj.nodeName === "string" && obj.nodeName.trim().length > 0) {
      cred.nodeName = obj.nodeName.trim();
    }
    return cred;
  } catch (err) {
    log.warn("Failed to load cred:", err);
    return null;
  }
}

export function saveGatewayAuthCred(cred: GatewayAuthCred): void {
  const file = getStorePath();
  ensureDir(file);
  secureWriteFileSync(file, JSON.stringify(cred, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function clearGatewayAuthCred(): void {
  const file = getStorePath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
