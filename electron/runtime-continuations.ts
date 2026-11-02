import { randomUUID } from "node:crypto";

import type { AgentMessageRecord } from "./agent-message-outbox";

export const RUNTIME_CONTINUATION_PREFIX = "runtime-continuation:";
interface ContinuationPort {
  enqueue(source: string, target: string, prompt: string, messageId: string): Promise<void>;
  waitAccepted(messageId: string): Promise<void>;
  cancelPending(messageId: string, source: string, target: string): Promise<void>;
  list(): readonly AgentMessageRecord[];
}

/** Owns only controller continuation envelopes, independently of user/agent messages. */
export class RuntimeContinuations {
  private readonly epochs = new Map<string, number>();
  private readonly enqueues = new Map<string, Set<Promise<void>>>();
  constructor(private readonly port: ContinuationPort) {}
  epoch(source: string, target: string): number {
    return this.epochs.get(JSON.stringify([source, target])) ?? 0;
  }

  async send(
    source: string,
    target: string,
    prompt: string,
    epoch: number,
  ): Promise<string | undefined> {
    if (this.epoch(source, target) !== epoch) return undefined;
    const messageId = `${RUNTIME_CONTINUATION_PREFIX}${randomUUID()}`;
    const enqueue = this.port.enqueue(source, target, prompt, messageId);
    const pending = this.enqueues.get(JSON.stringify([source, target])) ?? new Set<Promise<void>>();
    pending.add(enqueue);
    this.enqueues.set(JSON.stringify([source, target]), pending);
    try {
      await enqueue;
    } finally {
      pending.delete(enqueue);
      if (!pending.size) this.enqueues.delete(JSON.stringify([source, target]));
    }
    if (this.epoch(source, target) !== epoch) {
      await this.port.cancelPending(messageId, source, target);
      return undefined;
    }
    try {
      await this.port.waitAccepted(messageId);
    } catch (error) {
      if (this.epoch(source, target) !== epoch) return undefined;
      throw error;
    }
    return this.epoch(source, target) === epoch ? messageId : undefined;
  }

  async sendDirect(
    source: string,
    target: string,
    epoch: number,
    dispatch: () => Promise<void>,
  ): Promise<boolean> {
    let accepted = false;
    const operation = Promise.resolve().then(async () => {
      if (this.epoch(source, target) === epoch) {
        await dispatch();
        accepted = true;
      }
    });
    const pending = this.enqueues.get(JSON.stringify([source, target])) ?? new Set<Promise<void>>();
    pending.add(operation);
    this.enqueues.set(JSON.stringify([source, target]), pending);
    try {
      await operation;
    } finally {
      pending.delete(operation);
      if (!pending.size) this.enqueues.delete(JSON.stringify([source, target]));
    }
    return accepted;
  }

  async cancel(source: string, target: string): Promise<void> {
    this.epochs.set(JSON.stringify([source, target]), this.epoch(source, target) + 1);
    // Acceptance may be persisting while pause arrives. Fence first, then cancel
    // every exact owned envelope before the caller interrupts the active turn.
    await Promise.allSettled([...(this.enqueues.get(JSON.stringify([source, target])) ?? [])]);
    const owned = this.port
      .list()
      .filter(
        (message) =>
          message.messageId.startsWith(RUNTIME_CONTINUATION_PREFIX) &&
          message.source === source &&
          message.target === target,
      );
    await Promise.all(
      owned.map((message) => this.port.cancelPending(message.messageId, source, target)),
    );
  }
}
