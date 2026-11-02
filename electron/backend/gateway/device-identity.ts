/**
 * Gateway device identity — Ed25519 key management for the Marshal WebSocket handshake.
 *
 * Reads an adapter's device identity file, computes the device ID (SHA-256 of the raw
 * public key), and signs challenge nonces for the Marshal connect handshake.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { createLogger } from "../../../common/marshal-logger";
import { secureWriteFileSync } from "../../platform-security";

const log = createLogger("GatewayDeviceIdentity");

export interface DeviceIdentity {
  deviceId: string; // hex SHA-256 of raw public key bytes
  publicKeyBase64url: string; // base64url-encoded raw Ed25519 public key (32 bytes)
  privateKey: crypto.KeyObject; // parsed private key for signing
}

/**
 * Thrown when the identity file exists but can't be parsed / validated / loaded
 * into a usable key. Callers (e.g. GatewayBackend's reconnect loop) use this
 * to distinguish a recoverable transport error from a non-recoverable config
 * error — retrying a corrupted PEM will never succeed, so surface it instead.
 */
export class DeviceIdentityError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DeviceIdentityError";
  }
}

export interface SignedChallenge {
  deviceId: string;
  publicKeyBase64url: string;
  signatureBase64url: string;
  signedAt: number;
}

export function resolveDeviceIdentityPath(homeDir: string, overridePath?: string): string {
  // Marshal identity: MARSHAL_DEVICE_IDENTITY_PATH is owned by the Gateway service contract.
  const configuredPath = overridePath ?? process.env.MARSHAL_DEVICE_IDENTITY_PATH;
  if (configuredPath) return configuredPath;
  return path.join(homeDir, ".marshal", "marshal", "device-identity.json");
}

interface AdapterIdentityFile {
  device_id: string;
  public_key_b64: string;
  private_key_pem: string;
}

/**
 * Compute the device ID as a hex-encoded SHA-256 of the raw public key bytes.
 * The input is a base64url-encoded Ed25519 public key (32 bytes).
 */
function computeDeviceId(publicKeyBase64url: string): string {
  // base64url → Buffer (standard base64 with -/_ → +/)
  const raw = Buffer.from(publicKeyBase64url, "base64url");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Read a device identity file and return a DeviceIdentity.
 * If the file doesn't exist, generates a fresh Ed25519 keypair and persists it.
 *
 * The file uses the adapter's format:
 * ```json
 * {
 *   "device_id": "<hex>",
 *   "public_key_b64": "<base64url raw Ed25519 public key>",
 *   "private_key_pem": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
 * }
 * ```
 */
export function readDeviceIdentity(filePath: string): DeviceIdentity {
  if (!fs.existsSync(filePath)) {
    log.info(`No identity file at ${filePath} — generating fresh Ed25519 keypair`);
    return generateAndPersistIdentity(filePath);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: Partial<AdapterIdentityFile>;
  try {
    // SF-4: adapter config file — local trusted input. Validate shape below via typeof guards.
    parsed = JSON.parse(raw); // oxlint-disable-line sf4/no-bare-json-parse -- adapter config file, not untrusted remote input
  } catch (err) {
    throw new DeviceIdentityError(`Invalid JSON in adapter identity file at ${filePath}`, err);
  }

  const { device_id, public_key_b64, private_key_pem } = parsed;

  if (
    typeof device_id !== "string" ||
    typeof public_key_b64 !== "string" ||
    typeof private_key_pem !== "string"
  ) {
    throw new DeviceIdentityError(
      `Invalid adapter identity file at ${filePath}: missing required fields`,
    );
  }

  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(private_key_pem);
  } catch (err) {
    throw new DeviceIdentityError(
      `Invalid private key PEM in adapter identity file at ${filePath}`,
      err,
    );
  }

  return {
    deviceId: device_id,
    publicKeyBase64url: public_key_b64,
    privateKey,
  };
}

/**
 * Generate a fresh Ed25519 keypair and persist it in the adapter file format.
 * Used when dangerouslyDisableDeviceAuth is true on the gateway (local dev).
 */
function generateAndPersistIdentity(filePath: string): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

  // Extract the raw 32-byte Ed25519 public key from the SPKI DER encoding
  // SPKI for Ed25519 has a 12-byte header; raw key starts at offset 12
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const rawPubKey = spkiDer.subarray(12);
  const publicKeyBase64url = rawPubKey.toString("base64url");
  const deviceId = computeDeviceId(publicKeyBase64url);

  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });

  // Persist in the adapter's file format
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // 0600 — the file contains an Ed25519 private key. Keep it owner-only.
  secureWriteFileSync(
    filePath,
    JSON.stringify(
      {
        device_id: deviceId,
        public_key_b64: publicKeyBase64url,
        private_key_pem: privatePem,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  log.info(`Generated and saved identity to ${filePath} (device: ${deviceId.slice(0, 16)}...)`);

  return { deviceId, publicKeyBase64url, privateKey };
}

/**
 * Build the v2 signature payload string for the Marshal connect handshake.
 *
 * Format:
 *   v2|<device_id>|<clientName>|<clientMode>|<role>|<scopes-csv>|<ts>|<token>|<nonce>
 *
 * The role + scopes are part of the *signed* payload (not just the wire
 * params), so the same Ed25519 keypair can authenticate as either role
 * without the gateway accepting a swap mid-flight: the signature pins the
 * role this connection is asserting.
 */
function buildPayload(
  deviceId: string,
  ts: number,
  token: string,
  nonce: string,
  ctx: { clientName: string; clientMode: string; role: string; scopes: ReadonlyArray<string> },
): string {
  return [
    "v2",
    deviceId,
    ctx.clientName,
    ctx.clientMode,
    ctx.role,
    ctx.scopes.join(","),
    String(ts),
    token,
    nonce,
  ].join("|");
}

/** Defaults matching the operator role — kept here so callers that don't
 *  care about the role distinction (the existing operator path) need only
 *  pass the challenge to `signChallenge`. */
export const OPERATOR_ROLE = "operator" as const;
export const OPERATOR_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.admin",
  "operator.approvals",
] as const;
export const NODE_ROLE = "node" as const;
/** Nodes connect with empty scopes — capability is conveyed via `commands`
 *  declared at connect-time, not via scope strings. */
export const NODE_SCOPES: ReadonlyArray<string> = [] as const;

/**
 * Sign a challenge nonce for the Marshal connect handshake.
 *
 * Returns a SignedChallenge containing the device ID, public key, the base64url-encoded
 * Ed25519 signature over the v2 payload, and the timestamp used.
 *
 * `signCtx` controls which role + scopes the signature commits to; defaults
 * to operator + the operator scopes for backward compatibility with the
 * single-role call sites that pre-date the node-role split.
 */
export function signChallenge(
  identity: DeviceIdentity,
  challenge: { nonce: string; ts: number; token: string },
  signCtx: {
    clientName?: string;
    clientMode?: string;
    role?: string;
    scopes?: ReadonlyArray<string>;
  } = {},
): SignedChallenge {
  const { nonce, ts, token } = challenge;
  const payload = buildPayload(identity.deviceId, ts, token, nonce, {
    clientName: signCtx.clientName ?? "gateway-client",
    clientMode: signCtx.clientMode ?? "backend",
    role: signCtx.role ?? OPERATOR_ROLE,
    scopes: signCtx.scopes ?? OPERATOR_SCOPES,
  });

  // null algorithm is correct for Ed25519 — it is a pure signature scheme
  // that does not accept a separate hash algorithm parameter.
  const sigBuffer = crypto.sign(null, Buffer.from(payload), identity.privateKey);

  return {
    deviceId: identity.deviceId,
    publicKeyBase64url: identity.publicKeyBase64url,
    signatureBase64url: sigBuffer.toString("base64url"),
    signedAt: ts,
  };
}

export { computeDeviceId };
