import type {
  SessionStatusBatch,
  SessionStatusDelta,
  SessionView,
  SessionViewDelivery,
  SessionViewEvent,
  SessionViewSnapshot,
} from "../common/marshal-ipc-contract";

export const SESSION_STATUS_FLUSH_MS = 1_000;

export interface SessionViewIpcTarget {
  id: number;
  isDestroyed: () => boolean;
  send: (channel: string, payload: unknown) => void;
}

interface FullDeliveryState {
  lastSequence: number;
  inFlightSequence: number | null;
  pending: SessionViewEvent | null;
}

interface StatusDeliveryState {
  sequence: number;
  pending: Map<string, SessionStatusDelta>;
  timer: ReturnType<typeof setTimeout> | null;
}

function mergePending(previous: SessionViewEvent | null, next: SessionViewEvent): SessionViewEvent {
  if (!previous || previous.committedMessages.length === 0) return next;
  if (next.committedMessages.length === 0) {
    return { ...next, committedMessages: previous.committedMessages };
  }

  const messages = [...previous.committedMessages];
  const ids = new Set(messages.map((message) => message.id));
  for (const message of next.committedMessages) {
    if (!ids.has(message.id)) messages.push(message);
  }
  return { ...next, committedMessages: messages };
}

export class SessionViewIpcBroker {
  private readonly subscriptions = new Map<number, Set<string>>();
  private readonly deliveries = new Map<string, FullDeliveryState>();
  private readonly statusDeliveries = new Map<number, StatusDeliveryState>();

  constructor(
    private readonly getTargets: () => SessionViewIpcTarget[],
    private readonly getView: (sessionId: string) => SessionView,
    readonly epoch: string = crypto.randomUUID(),
  ) {}

  subscribe(webContentsId: number, sessionId: string): SessionViewSnapshot {
    let sessions = this.subscriptions.get(webContentsId);
    if (!sessions) {
      sessions = new Set<string>();
      this.subscriptions.set(webContentsId, sessions);
    }
    sessions.add(sessionId);
    const delivery = this.getDeliveryState(webContentsId, sessionId);
    delivery.inFlightSequence = null;
    delivery.pending = null;
    this.statusDeliveries.get(webContentsId)?.pending.delete(sessionId);
    return this.snapshot(webContentsId, sessionId);
  }

  isSubscribed(webContentsId: number, sessionId: string): boolean {
    return this.subscriptions.get(webContentsId)?.has(sessionId) ?? false;
  }

  unsubscribe(webContentsId: number, sessionId: string): void {
    const sessions = this.subscriptions.get(webContentsId);
    sessions?.delete(sessionId);
    if (sessions?.size === 0) this.subscriptions.delete(webContentsId);
    this.deliveries.delete(this.deliveryKey(webContentsId, sessionId));
  }

  resync(webContentsId: number, sessionId: string): SessionViewSnapshot {
    const state = this.getDeliveryState(webContentsId, sessionId);
    state.inFlightSequence = null;
    state.pending = null;
    return this.snapshot(webContentsId, sessionId);
  }

  acknowledge(webContentsId: number, sessionId: string, epoch: string, sequence: number): boolean {
    if (epoch !== this.epoch) return false;
    const state = this.deliveries.get(this.deliveryKey(webContentsId, sessionId));
    if (!state || state.inFlightSequence !== sequence) return false;

    state.inFlightSequence = null;
    const pending = state.pending;
    state.pending = null;
    if (pending) {
      const target = this.getTargets().find(
        (candidate) => candidate.id === webContentsId && !candidate.isDestroyed(),
      );
      if (target) this.sendFull(target, sessionId, pending, state);
    }
    return true;
  }

  publish(sessionId: string, event: SessionViewEvent): void {
    for (const target of this.getTargets()) {
      if (target.isDestroyed()) continue;
      if (this.subscriptions.get(target.id)?.has(sessionId)) {
        this.enqueueFull(target, sessionId, event);
      } else {
        this.enqueueStatus(target, sessionId, event.view);
      }
    }
  }

  removeTarget(webContentsId: number): void {
    this.subscriptions.delete(webContentsId);
    for (const key of this.deliveries.keys()) {
      if (key.startsWith(`${webContentsId}:`)) this.deliveries.delete(key);
    }
    const status = this.statusDeliveries.get(webContentsId);
    if (status?.timer) clearTimeout(status.timer);
    this.statusDeliveries.delete(webContentsId);
  }

  dispose(): void {
    for (const status of this.statusDeliveries.values()) {
      if (status.timer) clearTimeout(status.timer);
    }
    this.subscriptions.clear();
    this.deliveries.clear();
    this.statusDeliveries.clear();
  }

  private enqueueFull(
    target: SessionViewIpcTarget,
    sessionId: string,
    event: SessionViewEvent,
  ): void {
    const state = this.getDeliveryState(target.id, sessionId);
    if (state.inFlightSequence !== null) {
      state.pending = mergePending(state.pending, event);
      return;
    }
    this.sendFull(target, sessionId, event, state);
  }

  private sendFull(
    target: SessionViewIpcTarget,
    sessionId: string,
    event: SessionViewEvent,
    state: FullDeliveryState,
  ): void {
    const sequence = state.lastSequence + 1;
    state.lastSequence = sequence;
    state.inFlightSequence = sequence;
    target.send("session:view", {
      sessionId,
      ...event,
      epoch: this.epoch,
      sequence,
    } satisfies SessionViewDelivery);
  }

  private enqueueStatus(target: SessionViewIpcTarget, sessionId: string, view: SessionView): void {
    let state = this.statusDeliveries.get(target.id);
    if (!state) {
      state = { sequence: 0, pending: new Map(), timer: null };
      this.statusDeliveries.set(target.id, state);
    }
    state.pending.set(sessionId, {
      sessionId,
      status: view.status,
      sessionStatus: view.sessionStatus,
      hasError: view.error !== null,
    });
    if (state.timer) return;
    state.timer = setTimeout(() => this.flushStatus(target.id), SESSION_STATUS_FLUSH_MS);
  }

  private flushStatus(webContentsId: number): void {
    const state = this.statusDeliveries.get(webContentsId);
    if (!state) return;
    state.timer = null;
    if (state.pending.size === 0) return;
    const target = this.getTargets().find(
      (candidate) => candidate.id === webContentsId && !candidate.isDestroyed(),
    );
    if (!target) {
      state.pending.clear();
      return;
    }

    state.sequence += 1;
    const payload: SessionStatusBatch = {
      epoch: this.epoch,
      sequence: state.sequence,
      sessions: [...state.pending.values()],
    };
    state.pending.clear();
    target.send("sessions:status-delta", payload);
  }

  private snapshot(webContentsId: number, sessionId: string): SessionViewSnapshot {
    return {
      sessionId,
      epoch: this.epoch,
      sequence: this.getDeliveryState(webContentsId, sessionId).lastSequence,
      view: this.getView(sessionId),
    };
  }

  private getDeliveryState(webContentsId: number, sessionId: string): FullDeliveryState {
    const key = this.deliveryKey(webContentsId, sessionId);
    let state = this.deliveries.get(key);
    if (!state) {
      state = { lastSequence: 0, inFlightSequence: null, pending: null };
      this.deliveries.set(key, state);
    }
    return state;
  }

  private deliveryKey(webContentsId: number, sessionId: string): string {
    return `${webContentsId}:${sessionId}`;
  }
}
