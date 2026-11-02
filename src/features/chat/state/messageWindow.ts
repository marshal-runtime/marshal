export const CHAT_MESSAGE_WINDOW_SIZE = 20;

export interface MessageWindowItem {
  id: string;
  clientMessageId?: string;
  optimistic?: boolean;
  timestamp?: Date | string | number;
  role?: string;
  content?: string;
}

export interface MessageWindowResult<T> {
  messages: T[];
  addedCount: number;
  removedDuplicateCount: number;
  replacedCount: number;
  trimmedCount: number;
}

const heldTranscripts = new Set<string>();

/**
 * While someone is reading scrolled-up history, arrivals must not trim the
 * window: removing rows above the reader moves the text they are reading.
 */
export function setTranscriptHeld(sessionId: string, held: boolean): void {
  if (held) heldTranscripts.add(sessionId);
  else heldTranscripts.delete(sessionId);
}

export function isTranscriptHeld(sessionId: string): boolean {
  return heldTranscripts.has(sessionId);
}

export function trimMessageWindow<T>(messages: T[]): T[] {
  return messages.slice(-CHAT_MESSAGE_WINDOW_SIZE);
}

export interface AppendMessageWindowOptions {
  /** Older-history paging explicitly expands beyond the live window. */
  preserveLoadedHistory?: boolean;
}

function isConsecutiveAssistantDuplicate(
  previous: MessageWindowItem | undefined,
  message: MessageWindowItem,
): boolean {
  return (
    previous?.role === "assistant" &&
    message.role === "assistant" &&
    Boolean(previous.content) &&
    previous.content === message.content
  );
}

function keepConsecutiveAssistantCopy<T extends MessageWindowItem>(previous: T, incoming: T): T {
  if (previous.optimistic === true && incoming.optimistic !== true) {
    return { ...previous, ...incoming, optimistic: false };
  }
  if (incoming.optimistic !== true) return incoming;
  return previous;
}

function messageIdentityKeys(message: MessageWindowItem): string[] {
  return message.clientMessageId && message.clientMessageId !== message.id
    ? [message.id, message.clientMessageId]
    : [message.id];
}

function messagesCorrelate(left: MessageWindowItem, right: MessageWindowItem): boolean {
  const leftKeys = new Set(messageIdentityKeys(left));
  return messageIdentityKeys(right).some((key) => leftKeys.has(key));
}

function dedupeExistingMessages<T extends MessageWindowItem>(messages: T[]): T[] {
  const deduped: T[] = [];
  const identityIndexes = new Map<string, number>();
  for (const message of messages) {
    const keys = messageIdentityKeys(message);
    const last = deduped.at(-1);
    if (isConsecutiveAssistantDuplicate(last, message) && last) {
      const lastIndex = deduped.length - 1;
      deduped[lastIndex] = keepConsecutiveAssistantCopy(last, message);
      keys.forEach((key) => identityIndexes.set(key, lastIndex));
      continue;
    }
    const duplicateIndex = keys
      .map((key) => identityIndexes.get(key))
      .find((index) => index !== undefined);
    if (duplicateIndex === undefined) {
      const index = deduped.length;
      deduped.push(message);
      keys.forEach((key) => identityIndexes.set(key, index));
      continue;
    }
    const duplicate = deduped[duplicateIndex];
    if (duplicate.optimistic === true && message.optimistic !== true) {
      deduped[duplicateIndex] = {
        ...duplicate,
        ...message,
        optimistic: false,
      };
    } else if (message.optimistic !== true) {
      deduped[duplicateIndex] = message;
    }
    keys.forEach((key) => identityIndexes.set(key, duplicateIndex));
  }
  return deduped;
}

function timestampValue(message: MessageWindowItem): number | null {
  if (message.timestamp instanceof Date) {
    const value = message.timestamp.getTime();
    return Number.isFinite(value) ? value : null;
  }
  if (typeof message.timestamp === "number") {
    return Number.isFinite(message.timestamp) ? message.timestamp : null;
  }
  if (typeof message.timestamp === "string") {
    const value = Date.parse(message.timestamp);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function sortChronologically<T extends MessageWindowItem>(messages: T[]): T[] {
  const entries = messages.map((message, index) => ({
    message,
    index,
    timestamp: timestampValue(message),
  }));
  if (!entries.every((entry) => entry.timestamp !== null)) return messages;
  entries.sort(
    (left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0) || left.index - right.index,
  );
  return entries.map((entry) => entry.message);
}

function reconcileDuplicate<T extends MessageWindowItem>(existing: T, incoming: T): T {
  if (incoming.optimistic === true) return existing;
  if (
    existing.optimistic !== true &&
    (incoming.clientMessageId === undefined || incoming.id === existing.id)
  ) {
    return existing;
  }
  return {
    ...existing,
    ...incoming,
    optimistic: false,
  };
}

export function appendToMessageWindow<T extends MessageWindowItem>(
  existing: T[],
  incoming: T[],
  options: AppendMessageWindowOptions = {},
): MessageWindowResult<T> {
  const dedupedExisting = dedupeExistingMessages(existing);
  const merged = [...dedupedExisting];
  let addedCount = 0;
  let replacedCount = 0;
  for (const message of incoming) {
    const last = merged.at(-1);
    if (isConsecutiveAssistantDuplicate(last, message) && last) {
      const collapsed = keepConsecutiveAssistantCopy(last, message);
      if (collapsed !== last) replacedCount++;
      merged[merged.length - 1] = collapsed;
      continue;
    }
    const existingIndex = merged.findIndex((candidate) => messagesCorrelate(candidate, message));
    if (existingIndex === -1) {
      merged.push(message);
      addedCount++;
      continue;
    }
    const reconciled = reconcileDuplicate(merged[existingIndex], message);
    if (reconciled !== merged[existingIndex]) replacedCount++;
    merged[existingIndex] = reconciled;
  }
  const sorted = sortChronologically(merged);
  const messages = options.preserveLoadedHistory ? sorted : trimMessageWindow(sorted);
  return {
    messages,
    addedCount,
    removedDuplicateCount: existing.length - dedupedExisting.length,
    replacedCount,
    trimmedCount: sorted.length - messages.length,
  };
}

export function prependToMessageWindow<T extends MessageWindowItem>(
  existing: T[],
  incoming: T[],
): MessageWindowResult<T> {
  const dedupedExisting = dedupeExistingMessages(existing);
  const incomingIdentities = new Set<string>();
  const added = incoming.filter((message) => {
    const keys = messageIdentityKeys(message);
    if (
      dedupedExisting.some((candidate) => messagesCorrelate(candidate, message)) ||
      keys.some((key) => incomingIdentities.has(key))
    ) {
      return false;
    }
    keys.forEach((key) => incomingIdentities.add(key));
    return true;
  });
  return {
    messages: sortChronologically(dedupeExistingMessages([...added, ...dedupedExisting])),
    addedCount: added.length,
    removedDuplicateCount: existing.length - dedupedExisting.length,
    replacedCount: 0,
    trimmedCount: 0,
  };
}

export interface PrependScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  anchorMessageId?: string;
  anchorTop?: number;
}

export function calculatePrependScrollTop(
  previous: PrependScrollSnapshot,
  nextScrollHeight: number,
  nextAnchorTop?: number,
): number {
  if (previous.anchorTop !== undefined && nextAnchorTop !== undefined) {
    return previous.scrollTop + nextAnchorTop - previous.anchorTop;
  }
  return previous.scrollTop + Math.max(0, nextScrollHeight - previous.scrollHeight);
}
