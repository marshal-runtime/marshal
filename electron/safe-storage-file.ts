/**
 * Encrypted file I/O for session and memory data at rest.
 *
 * Uses a hybrid approach:
 *  - A random 256-bit AES key is generated once and protected via Electron safeStorage
 *  - Individual files are encrypted with AES-256-GCM (per-file random IV)
 *
 * File format (encrypted):
 *   [4 bytes: magic "MSE\x01"] [12 bytes: IV] [16 bytes: auth tag] [N bytes: ciphertext]
 *
 * Legacy plaintext files (no magic header) are read transparently and
 * encrypted on the next write — no migration step required.
 *
 * File permissions: mode 0o600 is enforced on macOS/Linux. On Windows, POSIX
 * mode bits are not applied (ACL-based security). This is intentional.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

import { app, safeStorage } from "electron";

import { createLogger } from "../common/marshal-logger";
import { getAppDataDir } from "./app-paths";

const log = createLogger("SafeStorage");

/**
 * Electron #45328: on macOS the safeStorage/OSCrypt keychain item name locks to
 * the default "Chromium Safe Storage" on the FIRST safeStorage access if that
 * access happens before app.whenReady() — permanently ignoring app.setName()
 * for the rest of the process. Guard every safeStorage entry point so a new
 * pre-ready caller (e.g. a store loading in its constructor) can't silently
 * reintroduce the bug. Throws in dev/test (loud, fix-it-now); logs but never
 * throws in a packaged build so a user is never blocked at startup.
 */
export function assertSafeStorageReady(op: string): void {
  let ready: boolean;
  try {
    ready = app.isReady();
  } catch {
    // `app` is unavailable (e.g. a pure unit test that doesn't mock it) — nothing to guard.
    return;
  }
  if (ready) return;
  const msg = `safeStorage accessed before app ready (${op}) — this locks the macOS keychain item name to "Chromium Safe Storage". Defer the read until after app.whenReady().`;
  if (app.isPackaged) {
    log.error(msg);
    return;
  }
  throw new Error(`[safe-storage-file] ${msg}`);
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAGIC = Buffer.from([0x4d, 0x53, 0x45, 0x01]); // "MSE" + version 1
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + IV_LENGTH + AUTH_TAG_LENGTH; // 32 bytes
const KEY_FILE_NAME = "marshal-encryption-key.enc";
const KEY_BACKUP_NAME = "marshal-encryption-key.enc.bak";
const MAX_DECRYPT_RETRIES = 3;
const RETRY_DELAY_MS = 500;

// ── Key management ───────────────────────────────────────────────────────────

let cachedKey: Buffer | null = null;

/**
 * Set to true when the key file existed but could not be decrypted (e.g. the
 * OS keychain changed after a machine reprovision). The app auto-recovers by
 * regenerating a fresh key, but all previously encrypted data becomes
 * unreadable. Callers should surface a user-visible notification.
 */
let keyWasReset = false;

function getKeyPath(): string {
  return path.join(getAppDataDir(), KEY_FILE_NAME);
}

function getBackupKeyPath(): string {
  return path.join(getAppDataDir(), KEY_BACKUP_NAME);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decrypt a safeStorage-encrypted key and validate it is 32 bytes. */
function decryptKey(encrypted: Buffer): Buffer {
  const b64 = safeStorage.decryptString(encrypted);
  const decoded = Buffer.from(b64, "base64");
  if (decoded.length !== 32)
    throw new Error(`[safe-storage-file] Invalid key length: ${decoded.length}`);
  return decoded;
}

/**
 * Load (or create) the AES-256 encryption key synchronously.
 * The key is generated once, encrypted with safeStorage, and cached in memory.
 * Returns null when safeStorage is unavailable (graceful plaintext fallback).
 *
 * If the key file exists but cannot be decrypted (e.g. OS keychain changed),
 * this function auto-recovers by deleting the corrupt file and regenerating a
 * new key. `wasEncryptionKeyReset()` will return true in that case.
 *
 * Exported so the workflows event-log writer (`electron/workflows/event-log.ts`)
 * can reuse the same cached key for per-line encryption via
 * `encryptLineWithKey` / `decryptLineWithKey`.
 */
export function loadOrCreateKey(): Buffer | null {
  if (cachedKey) return cachedKey;

  assertSafeStorageReady("loadOrCreateKey");

  if (!safeStorage.isEncryptionAvailable()) {
    return null;
  }

  const keyPath = getKeyPath();
  const backupPath = getBackupKeyPath();

  // ── .bak recovery ──────────────────────────────────────────────────────
  const bakExists = fs.existsSync(backupPath);
  if (bakExists) {
    const encExists = fs.existsSync(keyPath);
    if (encExists) {
      // Both exist — new key already generated last run, .bak is stale
      try {
        fs.unlinkSync(backupPath);
      } catch {
        // ignore
      }
    } else {
      // .bak exists but .enc doesn't — try to recover (with retries, since the
      // same transient keychain issues that caused the .bak can recur on restart)
      const encrypted = fs.readFileSync(backupPath);
      let recovered = false;
      for (let attempt = 1; attempt <= MAX_DECRYPT_RETRIES; attempt++) {
        try {
          const decoded = decryptKey(encrypted);
          // Recovery succeeded — restore .bak as .enc
          fs.renameSync(backupPath, keyPath);
          log.info("Recovered encryption key from backup");
          cachedKey = decoded;
          recovered = true;
          break;
        } catch (err) {
          if (attempt < MAX_DECRYPT_RETRIES) {
            log.warn(
              `Backup recovery attempt ${attempt}/${MAX_DECRYPT_RETRIES} failed, retrying:`,
              err,
            );
          } else {
            // All retries exhausted — genuine keychain change
            log.warn("Backup key recovery failed — deleting .bak:", err);
            try {
              fs.unlinkSync(backupPath);
            } catch {
              // ignore
            }
            keyWasReset = true;
          }
        }
      }
      if (recovered) return cachedKey;
      // fall through to generate new key
    }
  }

  // ── Normal key load (with retries) ─────────────────────────────────────
  // No delay between sync retries — this path may run before the window is
  // created (e.g. from the MemoryManager constructor), so blocking the main
  // thread with a sleep would freeze the app startup.
  if (fs.existsSync(keyPath)) {
    const encrypted = fs.readFileSync(keyPath);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_DECRYPT_RETRIES; attempt++) {
      try {
        cachedKey = decryptKey(encrypted);
        return cachedKey;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_DECRYPT_RETRIES) {
          log.warn(
            `Key decryption attempt ${attempt}/${MAX_DECRYPT_RETRIES} failed, retrying:`,
            err,
          );
        }
      }
    }
    // All retries exhausted — backup the key file instead of deleting it
    log.warn(
      `Key decryption failed after ${MAX_DECRYPT_RETRIES} attempts — backing up key:`,
      lastErr,
    );
    try {
      fs.renameSync(keyPath, backupPath);
    } catch {
      // If backup rename fails, try to delete so we can generate a new key
      try {
        fs.unlinkSync(keyPath);
      } catch {
        // ignore — generating a new key will overwrite it
      }
    }
    keyWasReset = true;
    // fall through to generate a new key
  }

  // ── Generate new key ───────────────────────────────────────────────────
  const key = randomBytes(32);
  const b64 = key.toString("base64");
  const encrypted = safeStorage.encryptString(b64);
  const dir = path.dirname(keyPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyTmp = `${keyPath}.tmp`;
  fs.writeFileSync(keyTmp, encrypted, { mode: 0o600 });
  fs.renameSync(keyTmp, keyPath);
  cachedKey = key;
  return cachedKey;
}

/**
 * Async variant of loadOrCreateKey() — uses fs.promises for non-blocking I/O.
 *
 * Call this once at app startup (before window creation) to pre-warm the key
 * cache on the async path and to detect keychain changes early. After this
 * resolves, all subsequent calls to the sync and async read/write functions
 * hit the in-memory cache with no I/O.
 *
 * If the key file exists but cannot be decrypted, auto-recovers by
 * regenerating a fresh key and sets `wasEncryptionKeyReset()` to true.
 */
export async function initEncryptionKeyAsync(): Promise<void> {
  if (cachedKey) return;
  assertSafeStorageReady("initEncryptionKeyAsync");
  if (!safeStorage.isEncryptionAvailable()) return;

  const keyPath = getKeyPath();
  const backupPath = getBackupKeyPath();

  // ── .bak recovery ──────────────────────────────────────────────────────
  const bakExists = await fs.promises
    .access(backupPath)
    .then(() => true)
    .catch(() => false);
  if (bakExists) {
    const encExists = await fs.promises
      .access(keyPath)
      .then(() => true)
      .catch(() => false);
    if (encExists) {
      // Both exist — new key already generated last run, .bak is stale
      try {
        await fs.promises.unlink(backupPath);
      } catch {
        // ignore
      }
    } else {
      // .bak exists but .enc doesn't — try to recover (with retries, since the
      // same transient keychain issues that caused the .bak can recur on restart)
      const bakEncrypted = await fs.promises.readFile(backupPath);
      let bakDecoded: Buffer | null = null;
      let bakLastErr: unknown;
      for (let attempt = 1; attempt <= MAX_DECRYPT_RETRIES; attempt++) {
        try {
          bakDecoded = decryptKey(bakEncrypted);
          break;
        } catch (err) {
          bakLastErr = err;
          if (attempt < MAX_DECRYPT_RETRIES) {
            log.warn(
              `Backup recovery attempt ${attempt}/${MAX_DECRYPT_RETRIES} failed, retrying:`,
              err,
            );
          }
        }
      }
      if (bakDecoded) {
        await fs.promises.rename(backupPath, keyPath);
        log.info("Recovered encryption key from backup");
        cachedKey = bakDecoded;
        return;
      }
      // All retries exhausted — genuine keychain change
      log.warn("Backup key recovery failed — deleting .bak:", bakLastErr);
      try {
        await fs.promises.unlink(backupPath);
      } catch {
        // ignore
      }
      keyWasReset = true;
      // fall through to generate new key
    }
  }

  // ── Normal key load (with retries) ─────────────────────────────────────
  const keyExists = await fs.promises
    .access(keyPath)
    .then(() => true)
    .catch(() => false);
  if (keyExists) {
    const encrypted = await fs.promises.readFile(keyPath);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_DECRYPT_RETRIES; attempt++) {
      try {
        cachedKey = decryptKey(encrypted);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_DECRYPT_RETRIES) {
          log.warn(
            `Key decryption attempt ${attempt}/${MAX_DECRYPT_RETRIES} failed, retrying:`,
            err,
          );
          // Pause before the final attempt to let the OS keychain settle
          if (attempt === MAX_DECRYPT_RETRIES - 1) {
            // eslint-disable-next-line no-await-in-loop -- deliberate: single delay before last retry
            await delay(RETRY_DELAY_MS);
          }
        }
      }
    }
    // All retries exhausted — backup the key file instead of deleting it
    log.warn(
      `Key decryption failed after ${MAX_DECRYPT_RETRIES} attempts — backing up key:`,
      lastErr,
    );
    try {
      await fs.promises.rename(keyPath, backupPath);
    } catch {
      try {
        await fs.promises.unlink(keyPath);
      } catch {
        // ignore
      }
    }
    keyWasReset = true;
    // fall through to generate a new key
  }

  // ── Generate new key ───────────────────────────────────────────────────
  const key = randomBytes(32);
  const b64 = key.toString("base64");
  const encrypted = safeStorage.encryptString(b64);
  const dir = path.dirname(keyPath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const keyTmp = `${keyPath}.tmp`;
  await fs.promises.writeFile(keyTmp, encrypted, { mode: 0o600 });
  await fs.promises.rename(keyTmp, keyPath);
  cachedKey = key;
}

/**
 * Returns true if the encryption key was regenerated during this session
 * because the OS keychain changed (key file could not be decrypted). Previously
 * encrypted local-only data is unreadable.
 */
export function wasEncryptionKeyReset(): boolean {
  return keyWasReset;
}

// ── Encryption / Decryption ──────────────────────────────────────────────────

function encrypt(key: Buffer, content: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(content, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([MAGIC, iv, authTag, encrypted]);
}

function decrypt(key: Buffer, buf: Buffer): string {
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
  const authTag = buf.subarray(MAGIC.length + IV_LENGTH, HEADER_LENGTH);
  const ciphertext = buf.subarray(HEADER_LENGTH);

  const decipher = createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

function isEncryptedFile(buf: Buffer): boolean {
  return buf.length >= HEADER_LENGTH && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Checks if a buffer starts with the magic bytes but is too short to be a
 * valid encrypted file — indicating a write that was interrupted mid-way.
 */
function isTruncatedEncryptedFile(buf: Buffer): boolean {
  return buf.length < HEADER_LENGTH && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Encrypt content and write synchronously. Falls back to plaintext if safeStorage unavailable. */
export function writeEncryptedFileSync(filePath: string, content: string): void {
  const key = loadOrCreateKey();
  const tmp = `${filePath}.tmp`;
  if (key) {
    fs.writeFileSync(tmp, encrypt(key, content), { mode: 0o600 });
  } else {
    log.warn("safeStorage unavailable — writing plaintext:", filePath);
    fs.writeFileSync(tmp, content, { mode: 0o600 });
  }
  fs.renameSync(tmp, filePath);
}

/** Read and decrypt synchronously. Transparently handles legacy plaintext files. */
export function readEncryptedFileSync(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  if (!isEncryptedFile(buf)) {
    if (isTruncatedEncryptedFile(buf)) {
      throw new Error("Encrypted file appears truncated or corrupt");
    }
    return buf.toString("utf-8");
  }
  const key = loadOrCreateKey();
  if (!key) throw new Error("Encryption key unavailable");
  return decrypt(key, buf);
}

const DURABLE_BACKUP_SUFFIX = ".bak";
const DURABLE_TEMP_SUFFIX = ".tmp";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncParentDirectory(filePath: string): Promise<void> {
  try {
    const handle = await fs.promises.open(path.dirname(filePath), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      isNodeErrorCode(error, "EINVAL") ||
      isNodeErrorCode(error, "ENOTSUP") ||
      isNodeErrorCode(error, "EPERM") ||
      isNodeErrorCode(error, "EISDIR")
    ) {
      return;
    }
    throw error;
  }
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
  }
}

async function writeBytesDurably(filePath: string, bytes: Buffer): Promise<void> {
  const tmp = `${filePath}${DURABLE_TEMP_SUFFIX}`;
  const backup = `${filePath}${DURABLE_BACKUP_SUFFIX}`;
  const backupTmp = `${backup}${DURABLE_TEMP_SUFFIX}`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await unlinkIfPresent(tmp);
  await unlinkIfPresent(backupTmp);
  try {
    await fs.promises.writeFile(tmp, bytes, { mode: 0o600 });
    await syncFile(tmp);

    if (await pathExists(filePath)) {
      await fs.promises.copyFile(filePath, backupTmp);
      await syncFile(backupTmp);
      await fs.promises.rename(backupTmp, backup);
      await syncParentDirectory(filePath);
    }

    await fs.promises.rename(tmp, filePath);
    await syncParentDirectory(filePath);
  } catch (error) {
    await unlinkIfPresent(tmp).catch(() => {});
    await unlinkIfPresent(backupTmp).catch(() => {});
    if (!(await pathExists(filePath)) && (await pathExists(backup))) {
      await fs.promises.copyFile(backup, tmp);
      await syncFile(tmp);
      await fs.promises.rename(tmp, filePath);
      await syncParentDirectory(filePath);
    }
    throw new Error(
      `Durable encrypted-file replacement was not acknowledged: ${formatError(error)}`,
      { cause: error },
    );
  }
}

async function restorePrimaryFromBackup(filePath: string, backupBytes: Buffer): Promise<void> {
  const tmp = `${filePath}${DURABLE_TEMP_SUFFIX}`;
  await unlinkIfPresent(tmp);
  await fs.promises.writeFile(tmp, backupBytes, { mode: 0o600 });
  await syncFile(tmp);
  await fs.promises.rename(tmp, filePath);
  await syncParentDirectory(filePath);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Encrypt content and durably replace the file. Falls back to plaintext if safeStorage unavailable. */
export async function writeEncryptedFile(filePath: string, content: string): Promise<void> {
  const key = loadOrCreateKey();
  let bytes: Buffer;
  if (key) {
    bytes = encrypt(key, content);
  } else {
    log.warn("safeStorage unavailable — writing plaintext:", filePath);
    bytes = Buffer.from(content);
  }
  await writeBytesDurably(filePath, bytes);
}

/** Strict diagnostic read: never initialize credentials, repair backups, or write files. */
export async function readEncryptedFileReadOnly(filePath: string): Promise<string> {
  const buf = await fs.promises.readFile(filePath);
  if (!isEncryptedFile(buf)) {
    if (isTruncatedEncryptedFile(buf))
      throw new Error("Encrypted file appears truncated or corrupt");
    return buf.toString("utf-8");
  }
  if (!cachedKey)
    throw new Error("Read-only encrypted access requires an already initialized encryption key.");
  return decrypt(cachedKey, buf);
}

/** Read and decrypt asynchronously. Transparently handles legacy plaintext files. */
export async function readEncryptedFile(filePath: string): Promise<string> {
  try {
    return await readEncryptedFilePrimary(filePath);
  } catch (primaryError) {
    const backupPath = `${filePath}${DURABLE_BACKUP_SUFFIX}`;
    if (!(await pathExists(backupPath))) throw primaryError;
    const recovered = await readEncryptedFilePrimary(backupPath);
    const backupBytes = await fs.promises.readFile(backupPath);
    await restorePrimaryFromBackup(filePath, backupBytes);
    return recovered;
  }
}

async function readEncryptedFilePrimary(filePath: string): Promise<string> {
  const buf = await fs.promises.readFile(filePath);
  if (!isEncryptedFile(buf)) {
    if (isTruncatedEncryptedFile(buf)) {
      throw new Error("Encrypted file appears truncated or corrupt");
    }
    return buf.toString("utf-8");
  }
  const key = loadOrCreateKey();
  if (!key) throw new Error("Encryption key unavailable");
  return decrypt(key, buf);
}

// ── Per-line encryption (for append-only logs) ───────────────────────────────
//
// Used by the workflows event-log writer (`electron/workflows/event-log.ts`)
// so each event line in `events.ndjson` can be independently encrypted and
// independently skipped on read if a write was interrupted mid-line.
//
// Wire format per line (decoded base64):
//   [5 bytes: MAGIC2 "MSEv\x02"] [12 bytes: IV] [16 bytes: auth tag] [N bytes: ciphertext]
//
// MAGIC2 is intentionally distinct from MAGIC (single-blob format used by
// writeEncryptedFileSync) so a tool reading bytes from disk can disambiguate
// the two framings without context.
//
// Callers append their own trailing newline ("\n") between encrypted lines —
// `encryptLineWithKey` returns base64-only with no terminator.

const MAGIC2 = Buffer.from([0x4d, 0x53, 0x45, 0x76, 0x02]); // "MSEv" + version 2
const LINE_HEADER_LENGTH = MAGIC2.length + IV_LENGTH + AUTH_TAG_LENGTH; // 33 bytes

/**
 * Tracks whether we have already logged the safeStorage-unavailable warning
 * for the line helpers. The warning is logged once per process (not once per
 * call) so a high-volume event log doesn't drown the log file.
 */
let lineFallbackWarned = false;

function warnLineFallbackOnce(): void {
  if (lineFallbackWarned) return;
  lineFallbackWarned = true;
  log.warn(
    "safeStorage unavailable — workflow event log lines will be written/read as plaintext base64. " +
      "This message is logged once per process.",
  );
}

/**
 * Encrypt a single event-log line. Returns base64-encoded framed bytes
 * (no trailing newline — the caller appends "\n" between lines).
 *
 * @param key  The AES-256 key returned by `loadOrCreateKey()`, or `null` if
 *             safeStorage is unavailable. When `null`, the payload is
 *             base64-encoded as-is (plaintext fallback) and a one-time
 *             warning is logged.
 * @param payload The UTF-8 plaintext (typically a JSON object) to encrypt.
 */
export function encryptLineWithKey(key: Buffer | null, payload: string): string {
  if (!key) {
    warnLineFallbackOnce();
    // Plaintext fallback: base64 the raw payload so the on-disk encoding is
    // still ASCII-clean. The reader detects the absence of MAGIC2 and
    // returns the decoded bytes verbatim.
    return Buffer.from(payload, "utf-8").toString("base64");
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([MAGIC2, iv, authTag, ciphertext]).toString("base64");
}

/**
 * Decrypt a single event-log line written by `encryptLineWithKey`. The input
 * must be the base64 string for one line, with no trailing newline.
 *
 * Throws if the line is corrupt (bad base64, truncated header, or GCM
 * auth-tag mismatch). Callers iterating an event log should catch and skip
 * the offending line — that is the documented partial-write recovery.
 *
 * @param key The AES-256 key, or `null` for plaintext-fallback reads (the
 *            line is treated as base64-encoded plaintext, mirroring the
 *            encrypt-side fallback). A one-time warning is logged.
 */
export function decryptLineWithKey(key: Buffer | null, line: string): string {
  const decoded = Buffer.from(line, "base64");
  const looksEncrypted =
    decoded.length >= LINE_HEADER_LENGTH && decoded.subarray(0, MAGIC2.length).equals(MAGIC2);

  if (!looksEncrypted) {
    // Plaintext-fallback line (encrypt-side had no key). Always honored on
    // read so a key-availability flip between writes does not strand
    // pre-existing data.
    if (!key) warnLineFallbackOnce();
    return decoded.toString("utf-8");
  }

  if (!key) {
    throw new Error(
      "Encrypted workflow log line found but encryption key is unavailable. " +
        "Was safeStorage disabled after writes were made?",
    );
  }

  const iv = decoded.subarray(MAGIC2.length, MAGIC2.length + IV_LENGTH);
  const authTag = decoded.subarray(MAGIC2.length + IV_LENGTH, LINE_HEADER_LENGTH);
  const ciphertext = decoded.subarray(LINE_HEADER_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

// ── Testing helpers (not exported from package, only used by tests) ──────────

export const _test = {
  resetCachedKey: () => {
    cachedKey = null;
  },
  resetKeyWasReset: () => {
    keyWasReset = false;
  },
  resetLineFallbackWarned: () => {
    lineFallbackWarned = false;
  },
  MAGIC,
  MAGIC2,
  HEADER_LENGTH,
  LINE_HEADER_LENGTH,
  MAX_DECRYPT_RETRIES,
  RETRY_DELAY_MS,
} as const;
