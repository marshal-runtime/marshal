import { createLogger } from "@common/marshal-logger";

import type { FileAttachment } from "../components/ChatInput";

const log = createLogger("UnsentMessages");

const STORAGE_KEY = "marshal.chat.unsent.v1";
const MAX_ENTRIES = 50;

/**
 * - `sending`: handed to the backend, not yet confirmed.
 * - `queued`: held behind a running turn, not yet handed to the backend.
 * - `failed`: the send failed and the session does not contain the message.
 */
export type UnsentStatus = "sending" | "queued" | "failed";

export interface UnsentMessage {
  /** clientMessageId for sends, queue item id for queued messages. */
  id: string;
  sessionId: string;
  text: string;
  files: FileAttachment[];
  createdAt: number;
  status: UnsentStatus;
  error?: string;
  /** Identifies the page load that wrote the entry; a stale `sending` or
   *  `queued` entry means the page reloaded before the message went out. */
  loadId: string;
  /** Attachments that did not fit in local storage and cannot be retried. */
  droppedFileNames?: string[];
}

export const PAGE_LOAD_ID =
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const EMPTY: UnsentMessage[] = [];
let entries: UnsentMessage[] = EMPTY;
/** Raw storage value `entries` was parsed from; a different value means
 *  another tab (or a storage reset) changed it and `entries` must re-parse. */
let syncedRaw: string | null | undefined;
let storageListenerAttached = false;
const listeners = new Set<() => void>();

function isFile(value: unknown): value is FileAttachment {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "mimeType") === "string"
  );
}

function isEntry(value: unknown): value is UnsentMessage {
  if (typeof value !== "object" || value === null) return false;
  const status: unknown = Reflect.get(value, "status");
  const files: unknown = Reflect.get(value, "files");
  return (
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "sessionId") === "string" &&
    typeof Reflect.get(value, "text") === "string" &&
    typeof Reflect.get(value, "createdAt") === "number" &&
    typeof Reflect.get(value, "loadId") === "string" &&
    (status === "sending" || status === "queued" || status === "failed") &&
    Array.isArray(files) &&
    files.every(isFile)
  );
}

function parseEntries(raw: string | null): UnsentMessage[] {
  if (!raw) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry) : EMPTY;
  } catch {
    return EMPTY;
  }
}

function sync() {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (raw === syncedRaw) return;
  syncedRaw = raw;
  entries = parseEntries(raw);
}

function withoutInlineFiles(entry: UnsentMessage): UnsentMessage {
  const inline = entry.files.filter((file) => file.dataUrl);
  if (inline.length === 0) return entry;
  return {
    ...entry,
    files: entry.files.filter((file) => !file.dataUrl),
    droppedFileNames: [...(entry.droppedFileNames ?? []), ...inline.map((file) => file.name)],
  };
}

function trySave(next: UnsentMessage[]): boolean {
  const raw = next.length === 0 ? null : JSON.stringify(next);
  try {
    if (raw === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    return false;
  }
  syncedRaw = raw;
  return true;
}

/** Text always persists; pasted images are dropped only when storage is full.
 *  If nothing fits, `syncedRaw` still matches storage, so the in-memory copy
 *  survives until the page closes. */
function persist(next: UnsentMessage[]): UnsentMessage[] {
  if (trySave(next)) return next;
  const slim = next.map(withoutInlineFiles);
  if (trySave(slim)) return slim;
  log.warn(`Could not persist ${next.length} unsent message(s); keeping them in memory only`);
  return next;
}

function notify() {
  listeners.forEach((listener) => listener());
}

function update(change: (current: UnsentMessage[]) => UnsentMessage[]) {
  sync();
  const next = change(entries);
  if (next === entries) return;
  entries = persist(next.slice(-MAX_ENTRIES));
  notify();
}

export function subscribeUnsent(listener: () => void): () => void {
  if (!storageListenerAttached && typeof window !== "undefined") {
    storageListenerAttached = true;
    window.addEventListener("storage", (event) => {
      if (event.key === STORAGE_KEY || event.key === null) notify();
    });
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUnsentSnapshot(): UnsentMessage[] {
  sync();
  return entries;
}

export function recordUnsent(
  entry: Omit<UnsentMessage, "createdAt" | "loadId"> & { createdAt?: number },
) {
  update((current) => [
    ...current.filter((existing) => existing.id !== entry.id),
    { ...entry, createdAt: entry.createdAt ?? Date.now(), loadId: PAGE_LOAD_ID },
  ]);
}

export function markUnsentFailed(id: string, error: string) {
  update((current) =>
    current.some((entry) => entry.id === id)
      ? current.map((entry) => (entry.id === id ? { ...entry, status: "failed", error } : entry))
      : current,
  );
}

export function removeUnsent(id: string) {
  update((current) =>
    current.some((entry) => entry.id === id) ? current.filter((entry) => entry.id !== id) : current,
  );
}

/** Drop entries the session already contains (the send reached the backend). */
export function pruneDeliveredUnsent(sessionId: string, deliveredIds: ReadonlySet<string>) {
  update((current) => {
    const next = current.filter(
      (entry) => entry.sessionId !== sessionId || !deliveredIds.has(entry.id),
    );
    return next.length === current.length ? current : next;
  });
}

/** Forget this page's queued entries when the live queue is cleared on purpose. */
export function forgetQueuedUnsent(sessionId: string) {
  update((current) => {
    const next = current.filter(
      (entry) =>
        entry.sessionId !== sessionId || entry.status !== "queued" || entry.loadId !== PAGE_LOAD_ID,
    );
    return next.length === current.length ? current : next;
  });
}

export interface VisibleUnsentMessage extends UnsentMessage {
  reason: string;
}

/**
 * Entries the user must act on: failed sends, plus sends and queued messages a
 * previous page load never finished (the reload itself is the failure).
 */
export function visibleUnsentMessages(
  all: readonly UnsentMessage[],
  sessionId: string,
  liveQueueIds: ReadonlySet<string>,
): VisibleUnsentMessage[] {
  return all.flatMap((entry): VisibleUnsentMessage[] => {
    if (entry.sessionId !== sessionId) return [];
    if (entry.status === "failed") {
      return [{ ...entry, reason: entry.error || "The message could not be sent." }];
    }
    if (entry.status === "sending" && entry.loadId !== PAGE_LOAD_ID) {
      return [{ ...entry, reason: "The app reloaded before the message was confirmed." }];
    }
    if (entry.status === "queued" && !liveQueueIds.has(entry.id)) {
      return [{ ...entry, reason: "It was waiting in the queue when the chat reloaded." }];
    }
    return [];
  });
}

/** Whether the session already holds a user message with this id. A failed
 *  lookup (e.g. no connection) counts as not delivered. */
export async function isMessageDelivered(sessionId: string, messageId: string): Promise<boolean> {
  try {
    const result = await window.sessionsAPI?.get(sessionId, { messageLimit: 40 });
    return (
      result?.success &&
      (result.session?.messages ?? []).some(
        (message) => message.role === "user" && message.id === messageId,
      )
    );
  } catch {
    return false;
  }
}
