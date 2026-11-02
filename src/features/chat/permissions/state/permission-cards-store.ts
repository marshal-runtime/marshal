import type { PermissionCardData } from "@/types/electron";

const EMPTY_CARDS: PermissionCardData[] = [];

class PermissionCardsState {
  private readonly cardsBySession = new Map<string, PermissionCardData[]>();
  private readonly subscribers = new Set<() => void>();
  private hasIpcSubscription = false;

  private subscribeToIpc(): void {
    if (this.hasIpcSubscription) return;

    this.hasIpcSubscription = true;
    window.permissionsAPI?.onCardsChanged?.((update) => {
      this.cardsBySession.set(update.sessionId, update.cards);
      this.notify();
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.subscribeToIpc();
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  };

  getSnapshot = (sessionId: string): PermissionCardData[] =>
    this.cardsBySession.get(sessionId) ?? EMPTY_CARDS;

  async fetch(sessionId: string): Promise<void> {
    const result = await window.permissionsAPI?.getCards(sessionId);
    if (result?.success && result.cards) {
      this.cardsBySession.set(sessionId, result.cards);
      this.notify();
    }
  }

  optimisticUpdate(
    sessionId: string,
    update: (cards: PermissionCardData[]) => PermissionCardData[],
  ): void {
    const previous = this.cardsBySession.get(sessionId) ?? EMPTY_CARDS;
    this.cardsBySession.set(sessionId, update(previous));
    this.notify();
  }

  clear(sessionId: string): void {
    this.cardsBySession.delete(sessionId);
    this.notify();
  }

  private notify(): void {
    this.subscribers.forEach((listener) => listener());
  }
}

export const permissionCardsStore = new PermissionCardsState();
