import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../testing/harness";
import { GatewayBackendTestAccess } from "../../test-helpers/gateway-backend-test-access";
import type { BackendEvent, ExecutionEventEnvelope } from "../types";
import { ExecutionConcurrencyLimitError } from "../types";
import { GatewaySessionBackend } from "./session";
import type { GatewayExecutionProtocolCapabilities, IGatewayWsClient } from "./ws-client";

type EventListener = (eventName: string, payload: Record<string, unknown>) => void;

function makeExecutionClient(capabilities: GatewayExecutionProtocolCapabilities) {
  let eventListener: EventListener | null = null;
  let attachedListener: EventListener | null = null;
  const chatSend = vi.fn<IGatewayWsClient["chatSend"]>(async ({ sessionKey }) => ({
    runId: sessionKey.replace("session-key-", "run-"),
  }));
  const chatAbort = vi.fn<IGatewayWsClient["chatAbort"]>(async ({ runId }) => ({
    ok: true,
    aborted: true,
    runIds: [runId],
  }));
  const sessionsDelete = vi.fn<IGatewayWsClient["sessionsDelete"]>(async ({ key }) => ({
    ok: true,
    key,
    deleted: true,
  }));
  const client = testDouble<IGatewayWsClient>({
    getExecutionCapabilities: () => capabilities,
    onEvent: (listener: EventListener) => {
      eventListener = listener;
      attachedListener = listener;
      return () => {
        if (eventListener === listener) eventListener = null;
      };
    },
    chatSend,
    chatAbort,
    sessionsDelete,
  });
  return {
    client,
    chatSend,
    chatAbort,
    sessionsDelete,
    emit(eventName: string, payload: Record<string, unknown>) {
      eventListener?.(eventName, payload);
    },
    emitFromDetachedClient(eventName: string, payload: Record<string, unknown>) {
      attachedListener?.(eventName, payload);
    },
  };
}

const MULTIPLEXED_CAPABILITIES: GatewayExecutionProtocolCapabilities = {
  version: 1,
  maxConcurrentRuns: 100,
  runCorrelation: "runId",
  cancellation: "runId",
  idempotency: "idempotencyKey",
  eventSequence: "seq",
  startAck: "before-events",
};

const LEGACY_CAPABILITIES: GatewayExecutionProtocolCapabilities = {
  version: 0,
  maxConcurrentRuns: 1,
  runCorrelation: "legacy-single-run",
  cancellation: "runId",
  idempotency: "idempotencyKey",
  eventSequence: "transport-order",
  startAck: "unspecified",
};

describe("GatewaySessionBackend execution routing", () => {
  it("forwards a stable session-send identity to gateway chat idempotency", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const fake = makeExecutionClient(MULTIPLEXED_CAPABILITIES);
    backend.attachClient(fake.client);
    access.setSessionKey("session-readiness", "session-key-readiness");

    const options = {
      localRunId: "subagent-readiness:parent:digest",
      idempotencyKey: "subagent-readiness:parent:digest",
    };
    await backend.send("session-readiness", { prompt: "resume orchestration" }, options);
    await backend.send("session-readiness", { prompt: "resume orchestration" }, options);

    expect(fake.chatSend).toHaveBeenCalledExactlyOnceWith({
      message: "resume orchestration",
      sessionKey: "session-key-readiness",
      idempotencyKey: "subagent-readiness:parent:digest",
    });
  });

  it("routes 100 interleaved runs by runId without loss, duplication, or cross-session delivery", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const fake = makeExecutionClient(MULTIPLEXED_CAPABILITIES);
    backend.attachClient(fake.client);

    const sessionEvents = new Map<string, BackendEvent[]>();
    const runEvents = new Map<string, ExecutionEventEnvelope[]>();
    for (let index = 0; index < 100; index++) {
      const sessionId = `session-${index}`;
      const localRunId = `local-${index}`;
      access.setSessionKey(sessionId, `session-key-${index}`);
      const sessionReceived: BackendEvent[] = [];
      const runReceived: ExecutionEventEnvelope[] = [];
      sessionEvents.set(sessionId, sessionReceived);
      runEvents.set(localRunId, runReceived);
      backend.subscribe(sessionId, (event) => sessionReceived.push(event));
      backend.subscribeRun(localRunId, (event) => runReceived.push(event));
    }

    const runs = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        backend.startRun(
          `session-${index}`,
          { prompt: `prompt-${index}` },
          { localRunId: `local-${index}` },
        ),
      ),
    );

    expect(fake.chatSend).toHaveBeenCalledTimes(100);
    expect(runs.map((run) => run.backendRunId)).toEqual(
      Array.from({ length: 100 }, (_, index) => `run-${index}`),
    );
    for (let index = 0; index < 100; index++) {
      expect(fake.chatSend.mock.calls[index][0].idempotencyKey).toBe(`local-${index}`);
    }

    const duplicate = await backend.startRun(
      "session-50",
      { prompt: "retry must not resubmit" },
      { localRunId: "local-50" },
    );
    expect(duplicate).toEqual(runs[50]);
    expect(fake.chatSend).toHaveBeenCalledTimes(100);

    const interleavedOrder = Array.from({ length: 100 }, (_, index) => (index * 37) % 100);
    for (const index of interleavedOrder) {
      const payload = {
        runId: `run-${index}`,
        sessionKey: `session-key-${index}`,
        seq: 1,
        stream: "assistant",
        data: { delta: `delta-${index}` },
      };
      fake.emit("agent", payload);
      fake.emit("agent", payload);
      fake.emit("agent", { ...payload, seq: 0, data: { delta: `stale-${index}` } });
    }
    for (const index of [...interleavedOrder].reverse()) {
      fake.emit("chat", {
        runId: `run-${index}`,
        sessionKey: `session-key-${index}`,
        seq: 2,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `final-${index}` }],
        },
      });
    }

    for (let index = 0; index < 100; index++) {
      const received = sessionEvents.get(`session-${index}`) ?? [];
      expect(received.map((event) => event.type)).toEqual(["text-delta", "turn-complete", "idle"]);
      expect(received[0]).toEqual({ type: "text-delta", text: `delta-${index}` });
      const completed = received[1];
      expect(completed.type).toBe("turn-complete");
      if (completed.type !== "turn-complete") throw new Error("expected turn-complete");
      expect(completed.message.content).toBe(`final-${index}`);

      const enveloped = runEvents.get(`local-${index}`) ?? [];
      expect(enveloped.map((event) => event.sequence)).toEqual([1, 2, 2]);
      expect(enveloped.every((event) => event.localRunId === `local-${index}`)).toBe(true);
      expect(enveloped.every((event) => event.backendRunId === `run-${index}`)).toBe(true);
      expect(enveloped.every((event) => event.sessionId === `session-${index}`)).toBe(true);
    }

    fake.emit("agent", {
      runId: "run-17",
      sessionKey: "session-key-17",
      seq: 3,
      stream: "assistant",
      data: { delta: "late" },
    });
    expect(sessionEvents.get("session-17")).toHaveLength(3);
  });

  it("cancels exactly one selected run and suppresses its late events", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const fake = makeExecutionClient({
      ...MULTIPLEXED_CAPABILITIES,
      maxConcurrentRuns: 4,
      eventSequence: "transport-order",
    });
    backend.attachClient(fake.client);
    access.setSessionKey("session-a", "session-key-a");
    access.setSessionKey("session-b", "session-key-b");

    const eventsA: BackendEvent[] = [];
    const eventsB: BackendEvent[] = [];
    backend.subscribe("session-a", (event) => eventsA.push(event));
    backend.subscribe("session-b", (event) => eventsB.push(event));
    await backend.startRun("session-a", { prompt: "a" }, { localRunId: "local-a" });
    await backend.startRun("session-b", { prompt: "b" }, { localRunId: "local-b" });

    await expect(backend.cancelRun("local-a")).resolves.toEqual({
      localRunId: "local-a",
      cancelled: true,
    });
    expect(fake.chatAbort).toHaveBeenCalledTimes(1);
    expect(fake.chatAbort).toHaveBeenCalledWith({
      sessionKey: "session-key-a",
      runId: "run-a",
    });

    fake.emit("agent", {
      runId: "run-a",
      sessionKey: "session-key-a",
      stream: "assistant",
      data: { delta: "late-a" },
    });
    fake.emit("agent", {
      runId: "run-b",
      sessionKey: "session-key-b",
      stream: "assistant",
      data: { delta: "live-b" },
    });
    expect(eventsA).toEqual([]);
    expect(eventsB).toEqual([{ type: "text-delta", text: "live-b" }]);
    expect(access.getActiveLocalRunId("session-b")).toBe("local-b");
    await expect(backend.cancelRun("unknown")).resolves.toEqual({
      localRunId: "unknown",
      cancelled: false,
    });
    expect(fake.chatAbort).toHaveBeenCalledTimes(1);
  });

  it("does not route runless compatibility events into an active tracked run", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const fake = makeExecutionClient(MULTIPLEXED_CAPABILITIES);
    backend.attachClient(fake.client);
    access.setSessionKey("session-a", "session-key-a");

    const events: BackendEvent[] = [];
    backend.subscribe("session-a", (event) => events.push(event));
    await backend.startRun("session-a", { prompt: "a" }, { localRunId: "local-a" });

    fake.emit("agent", {
      sessionKey: "session-key-a",
      seq: 1,
      stream: "assistant",
      data: { delta: "uncorrelated" },
    });
    expect(events).toEqual([]);

    fake.emit("chat", {
      runId: "run-a",
      sessionKey: "session-key-a",
      seq: 1,
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    });
    fake.emit("agent", {
      sessionKey: "session-key-a",
      stream: "assistant",
      data: { delta: "background" },
    });
    expect(events.at(-1)).toEqual({ type: "text-delta", text: "background" });
  });

  it("preserves active routes across reconnect while rejecting stale-client events", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const oldClient = makeExecutionClient(MULTIPLEXED_CAPABILITIES);
    backend.attachClient(oldClient.client);
    access.setSessionKey("session-a", "session-key-a");

    const events: BackendEvent[] = [];
    backend.subscribe("session-a", (event) => events.push(event));
    await backend.startRun("session-a", { prompt: "a" }, { localRunId: "local-a" });

    backend.detachClient(oldClient.client);
    oldClient.emitFromDetachedClient("agent", {
      runId: "run-a",
      sessionKey: "session-key-a",
      seq: 1,
      stream: "assistant",
      data: { delta: "stale-before-reattach" },
    });
    expect(events).toEqual([]);

    const newClient = makeExecutionClient(MULTIPLEXED_CAPABILITIES);
    backend.attachClient(newClient.client);
    const payload = {
      runId: "run-a",
      sessionKey: "session-key-a",
      seq: 1,
      stream: "assistant",
      data: { delta: "fresh" },
    };
    oldClient.emitFromDetachedClient("agent", {
      ...payload,
      data: { delta: "stale" },
    });
    expect(events).toEqual([]);

    newClient.emit("agent", payload);
    expect(events).toEqual([{ type: "text-delta", text: "fresh" }]);
    expect(access.getActiveLocalRunId("session-a")).toBe("local-a");
  });

  it("rejects a stale start acknowledgement after execution state is cleared", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    let acknowledge!: (value: { runId: string }) => void;
    const fake = makeExecutionClient(MULTIPLEXED_CAPABILITIES);
    fake.chatSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    backend.attachClient(fake.client);
    access.setSessionKey("session-a", "session-key-a");

    const start = backend.startRun("session-a", { prompt: "a" }, { localRunId: "local-a" });
    backend.clearSessionKeys();
    access.setSessionKey("session-a", "session-key-a");
    const replacement = await backend.startRun(
      "session-a",
      { prompt: "replacement" },
      { localRunId: "local-a" },
    );
    expect(replacement.backendRunId).toBe("run-a");

    acknowledge({ runId: "run-stale" });

    await expect(start).rejects.toThrow(/runtime changed before local-a was acknowledged/);
    expect(access.getActiveLocalRunId("session-a")).toBe("local-a");
    await expect(backend.cancelRun("local-a")).resolves.toEqual({
      localRunId: "local-a",
      cancelled: true,
    });
    expect(fake.chatAbort).toHaveBeenCalledWith({
      sessionKey: "session-key-a",
      runId: "run-a",
    });
  });

  it("releases an unacknowledged start on disconnect without dropping acknowledged routes", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    let acknowledge!: (value: { runId: string }) => void;
    const oldClient = makeExecutionClient(MULTIPLEXED_CAPABILITIES);
    oldClient.chatSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    backend.attachClient(oldClient.client);
    access.setSessionKey("session-a", "session-key-a");

    const staleStart = backend.startRun(
      "session-a",
      { prompt: "stale" },
      { localRunId: "local-a" },
    );
    backend.detachClient(oldClient.client);
    expect(access.getActiveLocalRunId("session-a")).toBeUndefined();

    const newClient = makeExecutionClient(MULTIPLEXED_CAPABILITIES);
    backend.attachClient(newClient.client);
    const replacement = await backend.startRun(
      "session-a",
      { prompt: "replacement" },
      { localRunId: "local-a" },
    );
    acknowledge({ runId: "run-stale" });

    await expect(staleStart).rejects.toThrow(/runtime changed before local-a was acknowledged/);
    expect(replacement.backendRunId).toBe("run-a");
    expect(access.getActiveLocalRunId("session-a")).toBe("local-a");
  });

  it("does not cache a legacy early completion when the start acknowledgement disagrees", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    let acknowledge!: (value: { runId: string }) => void;
    const fake = makeExecutionClient(LEGACY_CAPABILITIES);
    fake.chatSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    backend.attachClient(fake.client);
    access.setSessionKey("session-a", "session-key-a");

    const start = backend.startRun("session-a", { prompt: "a" }, { localRunId: "local-a" });
    fake.emit("chat", {
      runId: "run-early",
      sessionKey: "session-key-a",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "early" }],
      },
    });
    acknowledge({ runId: "run-ack" });

    await expect(start).rejects.toThrow(/acknowledged run-ack after completed run run-early/);
    const retry = await backend.startRun(
      "session-a",
      { prompt: "retry" },
      { localRunId: "local-a" },
    );
    expect(retry.backendRunId).toBe("run-a");
    expect(fake.chatSend).toHaveBeenCalledTimes(2);
  });

  it("fails closed at one in-flight run when the Gateway does not advertise execution v1", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const fake = makeExecutionClient(LEGACY_CAPABILITIES);
    backend.attachClient(fake.client);
    access.setSessionKey("session-a", "session-key-a");
    access.setSessionKey("session-b", "session-key-b");

    expect(backend.getCapabilities()).toMatchObject({
      concurrency: "legacy-single-run",
      maxConcurrentRuns: 1,
    });
    await backend.startRun("session-a", { prompt: "a" }, { localRunId: "local-a" });
    await expect(
      backend.startRun("session-b", { prompt: "b" }, { localRunId: "local-b" }),
    ).rejects.toBeInstanceOf(ExecutionConcurrencyLimitError);
    expect(fake.chatSend).toHaveBeenCalledTimes(1);
  });

  it("releases the route before a v1 abort response settles, then awaits acknowledgement", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const fake = makeExecutionClient({
      ...MULTIPLEXED_CAPABILITIES,
      maxConcurrentRuns: 2,
    });
    let resolveAbort!: (result: { ok: boolean; aborted: boolean; runIds: string[] }) => void;
    fake.chatAbort.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAbort = resolve;
        }),
    );
    backend.attachClient(fake.client);
    access.setSessionKey("session-a", "session-key-a");

    await backend.startRun("session-a", { prompt: "a" }, { localRunId: "local-a" });
    const cancellation = backend.cancelRun("local-a");
    let settled = false;
    void cancellation.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(access.getActiveLocalRunId("session-a")).toBeUndefined();

    resolveAbort({ ok: true, aborted: true, runIds: ["run-a"] });
    await expect(cancellation).resolves.toEqual({
      localRunId: "local-a",
      cancelled: true,
    });
  });

  it("keeps a rejected abort route fenced while surfacing the transport failure", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const fake = makeExecutionClient(MULTIPLEXED_CAPABILITIES);
    fake.chatAbort.mockRejectedValue(new Error("gateway unavailable"));
    backend.attachClient(fake.client);
    access.setSessionKey("session-a", "session-key-a");

    await backend.startRun("session-a", { prompt: "a" }, { localRunId: "local-a" });

    await expect(backend.cancelRun("local-a")).rejects.toThrow("gateway unavailable");
    expect(access.getActiveLocalRunId("session-a")).toBeUndefined();
  });

  it("releases a pending start immediately and aborts its late acknowledgement", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const fake = makeExecutionClient(MULTIPLEXED_CAPABILITIES);
    let acknowledge!: (value: { runId: string }) => void;
    fake.chatSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    backend.attachClient(fake.client);
    access.setSessionKey("session-a", "session-key-a");

    const start = backend.startRun("session-a", { prompt: "a" }, { localRunId: "local-a" });
    await expect(backend.cancelRun("local-a")).resolves.toEqual({
      localRunId: "local-a",
      cancelled: true,
    });
    expect(access.getActiveLocalRunId("session-a")).toBeUndefined();

    acknowledge({ runId: "run-late" });
    await expect(start).rejects.toThrow(/cancelled before acknowledgement/);
    expect(fake.chatAbort).toHaveBeenCalledWith({
      sessionKey: "session-key-a",
      runId: "run-late",
    });
  });

  it("drops an acknowledged route when its session is deleted", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const fake = makeExecutionClient({
      ...MULTIPLEXED_CAPABILITIES,
      maxConcurrentRuns: 1,
      eventSequence: "transport-order",
    });
    backend.attachClient(fake.client);
    access.setSessionKey("session-a", "session-key-a");
    access.setSessionKey("session-b", "session-key-b");

    const events: BackendEvent[] = [];
    backend.subscribe("session-a", (event) => events.push(event));
    await backend.startRun("session-a", { prompt: "a" }, { localRunId: "local-a" });

    await backend.destroy("session-a");

    expect(fake.sessionsDelete).toHaveBeenCalledWith({
      key: "session-key-a",
      deleteTranscript: true,
    });
    expect(access.getActiveLocalRunId("session-a")).toBeUndefined();
    fake.emit("agent", {
      runId: "run-a",
      sessionKey: "session-key-a",
      stream: "assistant",
      data: { delta: "late" },
    });
    expect(events).toEqual([]);
    await expect(
      backend.startRun("session-b", { prompt: "b" }, { localRunId: "local-b" }),
    ).resolves.toMatchObject({ backendRunId: "run-b" });
  });

  it("rejects a pending start acknowledgement after its session is deleted", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const fake = makeExecutionClient(MULTIPLEXED_CAPABILITIES);
    let acknowledge!: (value: { runId: string }) => void;
    fake.chatSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    backend.attachClient(fake.client);
    access.setSessionKey("session-a", "session-key-a");

    const start = backend.startRun("session-a", { prompt: "a" }, { localRunId: "local-a" });
    await backend.destroy("session-a");
    acknowledge({ runId: "run-stale" });

    await expect(start).rejects.toThrow(/runtime changed before local-a was acknowledged/);
    expect(access.getActiveLocalRunId("session-a")).toBeUndefined();
  });
});
