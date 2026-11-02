import { createContext, use, useEffect, useSyncExternalStore } from "react";

/** A committed timeline message, as card placement needs it. */
export interface TimelineMessageRef {
  readonly id: string;
  /** Epoch milliseconds. */
  readonly at: number;
}

export interface ConversationCardSnapshot {
  readonly messages: readonly TimelineMessageRef[];
  /** Slot names currently rendered by a message placeholder. */
  readonly mountedSlots: ReadonlySet<string>;
  /** Whether an agent turn is streaming, so its reply may still bind a slot. */
  readonly turnLive: boolean;
}

const EMPTY: ConversationCardSnapshot = {
  messages: [],
  mountedSlots: new Set(),
  turnLive: false,
};

/**
 * Shares what the chat timeline shows with the card surfaces: which messages
 * are committed (so permanent cards can sit after the right one) and which
 * `<!--ui:name-->` slots are on screen (so slot-bound cards are not repeated
 * in the conversation list).
 */
export class ConversationCardStore {
  private snapshot: ConversationCardSnapshot = EMPTY;
  private messageSignature = "";
  private readonly slotCounts = new Map<string, number>();
  private liveTurns = 0;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ConversationCardSnapshot => this.snapshot;

  setMessages(messages: readonly TimelineMessageRef[]): void {
    const signature = messages.map((message) => `${message.id}@${message.at}`).join("|");
    if (signature === this.messageSignature) return;
    this.messageSignature = signature;
    this.snapshot = { ...this.snapshot, messages };
    this.emit();
  }

  registerSlot(name: string): () => void {
    this.slotCounts.set(name, (this.slotCounts.get(name) ?? 0) + 1);
    this.publishSlots();
    return () => {
      const count = (this.slotCounts.get(name) ?? 1) - 1;
      if (count <= 0) this.slotCounts.delete(name);
      else this.slotCounts.set(name, count);
      this.publishSlots();
    };
  }

  registerLiveTurn(): () => void {
    this.liveTurns += 1;
    this.publishTurnLive();
    return () => {
      this.liveTurns = Math.max(0, this.liveTurns - 1);
      this.publishTurnLive();
    };
  }

  private publishTurnLive(): void {
    const turnLive = this.liveTurns > 0;
    if (turnLive === this.snapshot.turnLive) return;
    this.snapshot = { ...this.snapshot, turnLive };
    this.emit();
  }

  private publishSlots(): void {
    this.snapshot = { ...this.snapshot, mountedSlots: new Set(this.slotCounts.keys()) };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const ConversationCardStoreContext = createContext<ConversationCardStore | null>(null);

const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;

export function useConversationCardSnapshot(): ConversationCardSnapshot {
  const store = use(ConversationCardStoreContext);
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? emptySnapshot,
  );
}

/** The chat timeline reports its committed messages for card placement. */
export function usePublishTimelineMessages(messages: readonly TimelineMessageRef[]): void {
  const store = use(ConversationCardStoreContext);
  // The store ignores lists whose ids and times did not change.
  useEffect(() => store?.setMessages(messages), [store, messages]);
}

export function useRegisterSlot(name: string): void {
  const store = use(ConversationCardStoreContext);
  useEffect(() => store?.registerSlot(name), [store, name]);
}

/** Marks an agent turn as live while the calling component is mounted. */
export function useRegisterLiveTurn(): void {
  const store = use(ConversationCardStoreContext);
  useEffect(() => store?.registerLiveTurn(), [store]);
}
