import { useCallback, useState } from "react";

import type { FileAttachment } from "../components/ChatInput";

export interface QueuedMessage {
  id: string;
  text: string;
  files: FileAttachment[];
}

const EMPTY: QueuedMessage[] = [];

function makeQueueId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `q-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export interface UseMessageQueue {
  /** Queued messages for the active session, in FIFO order. */
  queue: QueuedMessage[];
  enqueue: (sessionId: string, text: string, files: FileAttachment[]) => QueuedMessage;
  removeItem: (sessionId: string, id: string) => void;
  clearSession: (sessionId: string) => void;
}

/**
 * Per-session message queue. While a turn is running, user submissions are held
 * here (keyed by sessionId so switching conversations never drains into the
 * wrong one) and drained one-at-a-time by ChatPanel when the session goes idle.
 */
export function useMessageQueue(sessionId: string | null): UseMessageQueue {
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});

  const queue = sessionId ? (queues[sessionId] ?? EMPTY) : EMPTY;

  const enqueue = useCallback(
    (sid: string, text: string, files: FileAttachment[]): QueuedMessage => {
      const item: QueuedMessage = { id: makeQueueId(), text, files };
      setQueues((prev) => ({ ...prev, [sid]: [...(prev[sid] ?? []), item] }));
      return item;
    },
    [],
  );

  const removeItem = useCallback((sid: string, id: string) => {
    setQueues((prev) => {
      const current = prev[sid];
      if (!current) return prev;
      return { ...prev, [sid]: current.filter((i) => i.id !== id) };
    });
  }, []);

  const clearSession = useCallback((sid: string) => {
    setQueues((prev) => {
      if (!(sid in prev)) return prev;
      const next = { ...prev };
      delete next[sid];
      return next;
    });
  }, []);

  return { queue, enqueue, removeItem, clearSession };
}
