/**
 * Encrypted GitHub token persistence for the automations import flow.
 */

import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";

import { safeStorage } from "electron";

import { getAppDataDir } from "./app-paths";
import { secureMkdirSync, secureWriteFileSync } from "./platform-security";

const IMPORT_TOKEN_PATH = join(getAppDataDir(), "marshal-github-import-token.enc");
// Written by the retired GitHub-releases updater; removed when the renderer clears update auth.
const LEGACY_UPDATE_TOKEN_PATH = join(getAppDataDir(), "marshal-github-update-token.enc");
let importSessionToken: string | null = null;

export function getCachedImportToken(): string | null {
  if (importSessionToken) return importSessionToken;
  try {
    if (!existsSync(IMPORT_TOKEN_PATH)) return null;
    const encrypted = readFileSync(IMPORT_TOKEN_PATH);
    if (!encrypted.length) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const token = safeStorage.decryptString(encrypted);
    importSessionToken = token;
    return token;
  } catch {
    return null;
  }
}

export function setCachedImportToken(token: string): void {
  importSessionToken = token;
  try {
    secureMkdirSync(getAppDataDir(), 0o700);
    if (!safeStorage.isEncryptionAvailable()) return;
    secureWriteFileSync(IMPORT_TOKEN_PATH, safeStorage.encryptString(token), { mode: 0o600 });
  } catch {
    /* best effort — token is still live in memory */
  }
}

export function clearImportToken(): void {
  importSessionToken = null;
  try {
    if (existsSync(IMPORT_TOKEN_PATH)) rmSync(IMPORT_TOKEN_PATH);
  } catch {
    /* best effort */
  }
}

export function clearLegacyUpdateToken(): void {
  try {
    if (existsSync(LEGACY_UPDATE_TOKEN_PATH)) rmSync(LEGACY_UPDATE_TOKEN_PATH);
  } catch {
    /* best effort */
  }
}
