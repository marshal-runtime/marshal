import { safeStorage } from "electron";

import { createLogger } from "../../../common/marshal-logger";
import type { CustomMcpServer } from "../../ipc/types";
import { assertSafeStorageReady } from "../../safe-storage-file";

const log = createLogger("McpCrypto");

// ── Derived types for on-disk persistence ──────────────────────────────────

// On-disk shape for URL-based servers: tokens replaced by encrypted base64 blobs.
// Legacy plaintext fields (accessToken/refreshToken) may appear in old files — migrated on next save.
type RemoteMcpServer = Extract<CustomMcpServer, { url: string }>;
type PersistedRemoteMcpServer = Omit<RemoteMcpServer, "accessToken" | "refreshToken"> & {
  accessTokenEncrypted?: string;
  refreshTokenEncrypted?: string;
  accessToken?: string; // legacy
  refreshToken?: string; // legacy
};
type CommandMcpServer = Extract<CustomMcpServer, { type: "command" }>;
export type PersistedCustomMcpServer = PersistedRemoteMcpServer | CommandMcpServer;

// ── Token encryption helpers ───────────────────────────────────────────────

function encryptToken(value: string): string | undefined {
  assertSafeStorageReady("mcp-crypto.encryptToken");
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.encryptString(value).toString("base64");
  } catch {
    return undefined;
  }
}

function decryptToken(encoded: string): string | undefined {
  assertSafeStorageReady("mcp-crypto.decryptToken");
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch {
    return undefined;
  }
}

function encodePersistedToken(
  target: PersistedRemoteMcpServer,
  key: "accessTokenEncrypted" | "refreshTokenEncrypted",
  value: string,
  name: string,
  warning: string,
): void {
  const encrypted = encryptToken(value);
  if (encrypted) {
    target[key] = encrypted;
  } else {
    log.warn(`safeStorage unavailable — skipping ${warning} persistence for "${name}"`);
  }
}

// ── Server serialization (encrypt on write, decrypt on read) ───────────────

export function serializeServer(server: CustomMcpServer): PersistedCustomMcpServer {
  if (server.type === "command") return server;
  const { accessToken, refreshToken, ...rest } = server;
  const persisted: PersistedRemoteMcpServer = { ...rest };
  if (accessToken)
    encodePersistedToken(persisted, "accessTokenEncrypted", accessToken, server.name, "token");
  if (refreshToken) {
    encodePersistedToken(
      persisted,
      "refreshTokenEncrypted",
      refreshToken,
      server.name,
      "refresh token",
    );
  }
  return persisted;
}

export function deserializeServer(persisted: PersistedCustomMcpServer): CustomMcpServer {
  if (persisted.type === "command") return persisted;
  const {
    accessTokenEncrypted,
    refreshTokenEncrypted,
    accessToken: legacyAccess,
    refreshToken: legacyRefresh,
    ...rest
  } = persisted;
  const server: RemoteMcpServer = { ...rest };
  if (accessTokenEncrypted) {
    const decrypted = decryptToken(accessTokenEncrypted);
    if (!decrypted) {
      log.warn(`Failed to decrypt access token for "${rest.name}" — re-authentication required`);
    }
    server.accessToken = decrypted;
  } else if (legacyAccess) {
    server.accessToken = legacyAccess; // old file — will be encrypted on next save
  }
  if (refreshTokenEncrypted) {
    const decrypted = decryptToken(refreshTokenEncrypted);
    if (!decrypted) {
      log.warn(`Failed to decrypt refresh token for "${rest.name}" — re-authentication required`);
    }
    server.refreshToken = decrypted;
  } else if (legacyRefresh) {
    server.refreshToken = legacyRefresh;
  }
  return server;
}
