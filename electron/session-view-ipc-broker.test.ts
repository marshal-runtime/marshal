import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SESSION_VIEW,
  type SessionStatusBatch,
  type SessionViewDelivery,
  type SessionViewEvent,
} from "../common/marshal-ipc-contract";
import {
  SESSION_STATUS_FLUSH_MS,
  SessionViewIpcBroker,
  type SessionViewIpcTarget,
} from "./session-view-ipc-broker";

function event(streamingText: string, committedMessageId?: string): SessionViewEvent {
  return {
    type: "session:view",
    view: { ...DEFAULT_SESSION_VIEW, status: "streaming", streamingText },
    committedMessages: committedMessageId
      ? [
          {
            id: committedMessageId,
            role: "assistant",
            content: committedMessageId,
            timestamp: "2026-07-12T00:00:00.000Z",
          },
        ]
      : [],
  };
}

function makeTarget(id: number): SessionViewIpcTarget & { send: ReturnType<typeof vi.fn> } {
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn<(channel: string, payload: unknown) => void>(),
  };
}

function isViewDelivery(value: unknown): value is SessionViewDelivery {
  return typeof value !== "object" || value === null
    ? false
    : Reflect.get(value, "type") === "session:view" &&
        typeof Reflect.get(value, "sessionId") === "string" &&
        typeof Reflect.get(value, "epoch") === "string" &&
        typeof Reflect.get(value, "sequence") === "number";
}

function viewDelivery(value: unknown): SessionViewDelivery {
  if (!isViewDelivery(value)) throw new Error("Expected SessionViewDelivery");
  return value;
}

function isStatusBatch(value: unknown): value is SessionStatusBatch {
  return typeof value !== "object" || value === null
    ? false
    : typeof Reflect.get(value, "epoch") === "string" &&
        typeof Reflect.get(value, "sequence") === "number" &&
        Array.isArray(Reflect.get(value, "sessions"));
}

function statusBatch(value: unknown): SessionStatusBatch {
  if (!isStatusBatch(value)) throw new Error("Expected SessionStatusBatch");
  return value;
}

describe("SessionViewIpcBroker", () => {
  afterEach(() => vi.useRealTimers());

  it("routes 100 sessions at 12.5 Hz without irrelevant full views or an unbounded queue", () => {
    vi.useFakeTimers();
    const target = makeTarget(7);
    const broker = new SessionViewIpcBroker(
      () => [target],
      () => DEFAULT_SESSION_VIEW,
      "runtime-1",
    );
    broker.subscribe(target.id, "session-0");

    for (let tick = 0; tick < 13; tick += 1) {
      for (let session = 0; session < 100; session += 1) {
        broker.publish(`session-${session}`, event(`tick-${tick}`));
      }
    }

    const fullBeforeAck = target.send.mock.calls.filter(([channel]) => channel === "session:view");
    expect(fullBeforeAck).toHaveLength(1);
    expect(viewDelivery(fullBeforeAck[0][1]).sessionId).toBe("session-0");

    const first = viewDelivery(fullBeforeAck[0][1]);
    expect(broker.acknowledge(target.id, first.sessionId, first.epoch, first.sequence)).toBe(true);
    const fullAfterAck = target.send.mock.calls.filter(([channel]) => channel === "session:view");
    expect(fullAfterAck).toHaveLength(2);
    expect(viewDelivery(fullAfterAck[1][1]).view.streamingText).toBe("tick-12");

    vi.advanceTimersByTime(SESSION_STATUS_FLUSH_MS);
    const statusCalls = target.send.mock.calls.filter(
      ([channel]) => channel === "sessions:status-delta",
    );
    expect(statusCalls).toHaveLength(1);
    const status = statusBatch(statusCalls[0][1]);
    expect(status.sessions).toHaveLength(99);
    expect(status.sessions.some((delta) => delta.sessionId === "session-0")).toBe(false);
    broker.dispose();
  });

  it("preserves committed messages while replacing pending transient state with the latest view", () => {
    const target = makeTarget(9);
    const broker = new SessionViewIpcBroker(
      () => [target],
      () => DEFAULT_SESSION_VIEW,
      "runtime-2",
    );
    broker.subscribe(target.id, "selected");
    broker.publish("selected", event("first"));
    broker.publish("selected", event("second", "committed-1"));
    broker.publish("selected", event("latest"));

    const first = viewDelivery(target.send.mock.calls[0][1]);
    broker.acknowledge(target.id, "selected", first.epoch, first.sequence);

    const latest = viewDelivery(target.send.mock.calls[1][1]);
    expect(latest.view.streamingText).toBe("latest");
    expect(latest.committedMessages.map((message) => message.id)).toEqual(["committed-1"]);
    broker.dispose();
  });

  it("resets backpressure on resync and rejects stale runtime acknowledgements", () => {
    const target = makeTarget(11);
    const currentView = { ...DEFAULT_SESSION_VIEW, status: "ready" as const };
    const broker = new SessionViewIpcBroker(
      () => [target],
      () => currentView,
      "runtime-3",
    );
    const initial = broker.subscribe(target.id, "selected");
    broker.publish("selected", event("in-flight"));

    expect(broker.acknowledge(target.id, "selected", "old-runtime", 1)).toBe(false);
    const snapshot = broker.resync(target.id, "selected");
    expect(snapshot).toEqual({ ...initial, view: currentView, sequence: 1 });

    broker.publish("selected", event("after-resync"));
    const delivery = viewDelivery(target.send.mock.calls.at(-1)?.[1]);
    expect(delivery.sequence).toBe(2);
    broker.dispose();
  });

  it("releases an unacknowledged delivery when a renderer subscribes again", () => {
    const target = makeTarget(13);
    const broker = new SessionViewIpcBroker(
      () => [target],
      () => DEFAULT_SESSION_VIEW,
      "runtime-4",
    );
    broker.subscribe(target.id, "selected");
    broker.publish("selected", event("before-reload"));

    const snapshot = broker.subscribe(target.id, "selected");
    expect(snapshot.sequence).toBe(1);

    broker.publish("selected", event("after-reload"));
    const delivery = viewDelivery(target.send.mock.calls.at(-1)?.[1]);
    expect(delivery.sequence).toBe(2);
    expect(delivery.view.streamingText).toBe("after-reload");
    broker.dispose();
  });
});
