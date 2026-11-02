// Marshal-owned manual safe-storage test boundary; keep this path for Vitest discovery.

import * as fsMod from "fs";

/**
 * Manual vitest mock for ./safe-storage-file.
 * Session test files call `vi.mock("./safe-storage-file")` (no factory) and this
 * module is automatically used. Delegates to the already-mocked `fs` module so
 * tests control behaviour through their existing `vi.mocked(fs)` setup.
 */
import { vi } from "vitest";

export function writeEncryptedFileSync(p: string, c: string): void {
  fsMod.writeFileSync(p, c);
}

export function readEncryptedFileSync(p: string): string {
  return fsMod.readFileSync(p, "utf-8");
}

export async function writeEncryptedFile(p: string, c: string): Promise<void> {
  await fsMod.promises.writeFile(p, c);
}

export async function readEncryptedFile(p: string): Promise<string> {
  return await fsMod.promises.readFile(p, "utf-8");
}

export const initEncryptionKeyAsync = vi.fn<() => Promise<void>>(() => Promise.resolve());

export const wasEncryptionKeyReset = vi.fn<() => boolean>(() => false);

export const _test = {
  resetCachedKey: vi.fn<() => void>(),
  resetKeyWasReset: vi.fn<() => void>(),
  MAGIC: Buffer.from([0x4d, 0x53, 0x45, 0x01]),
  HEADER_LENGTH: 32,
} as const;
