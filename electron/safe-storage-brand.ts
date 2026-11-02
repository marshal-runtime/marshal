import path from "node:path";

import { APP_NAME } from "../common/marshal-constants";

interface AppNamePort {
  setName(name: string): void;
}

interface SafeStorageInitializationPort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
}

export function prepareSafeStorageAppName(app: AppNamePort): void {
  app.setName(APP_NAME);
}

export function finalizeSafeStorageAppName(
  app: AppNamePort,
  safeStorage: SafeStorageInitializationPort,
): void {
  if (safeStorage.isEncryptionAvailable()) {
    safeStorage.encryptString("");
  }
  app.setName(APP_NAME);
}

/**
 * Marshal's own userData root.
 *
 * Chromium keeps its single-instance lock in Marshal's own user-data root.
 */
export function userDataPath(appDataDir: string): string {
  return path.join(appDataDir, APP_NAME);
}

export function resolveCommandLineUserDataDir(requestedUserData: string): string | null {
  const trimmed = requestedUserData.trim();
  if (!trimmed) return null;
  if (!path.isAbsolute(trimmed)) {
    throw new Error("Electron user-data directory must be absolute.");
  }
  return path.resolve(trimmed);
}
