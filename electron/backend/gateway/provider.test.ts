/**
 * Unit tests for GatewaySessionBackend — focused on event dispatch invariants
 * that can't be covered by normalizeGatewayEvent alone.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/mock", getPath: () => "/mock" },
}));

// Mock the WS client at module level so GatewayBackend.login / init exercise
// the real code path (close old client, call connect, attach, set ready) without
// opening a socket. vi.hoisted() gives tests a handle on the latest mock client
// instance created by `new GatewayWsClient(...)`.
type StateChangeListener = (state: "connecting" | "connected" | "disconnected") => void;
type EventListener = (eventName: string, payload: Record<string, unknown>) => void;

interface MockWsClient {
  connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  close: ReturnType<typeof vi.fn<() => void>>;
  isConnected: ReturnType<typeof vi.fn<() => boolean>>;
  getExecutionCapabilities: () => {
    version: 0;
    maxConcurrentRuns: 1;
    runCorrelation: "legacy-single-run";
    cancellation: "runId";
    idempotency: "idempotencyKey";
    eventSequence: "transport-order";
    startAck: "unspecified";
  };
  request: ReturnType<typeof vi.fn<() => Promise<Record<string, unknown>>>>;
  onEvent: ReturnType<typeof vi.fn<(l: EventListener) => () => void>>;
  onStateChange: ReturnType<typeof vi.fn<() => () => void>>;
  emitEvent: (eventName: string, payload: Record<string, unknown>) => void;
  registerInboundHandler: ReturnType<
    typeof vi.fn<
      (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => () => void
    >
  >;
  /** Behavioural surface for desktop-capability tests — the bridge / approval
   *  router register here, so tests assert by method name instead of by
   *  poking private fields on `GatewayBackend`. */
  inboundHandlers: Map<string, (params: Record<string, unknown>) => Promise<unknown>>;
  inboundUnregisters: Map<string, ReturnType<typeof vi.fn<() => void>>>;
  // Captured constructor config — lets tests assert the authToken passthrough.
  config: Record<string, unknown>;
  // Fires all registered state-change listeners synchronously. Tests use this
  // to simulate the real client's "disconnected" notification without
  // involving a real socket.
  emitState: (state: "connecting" | "connected" | "disconnected") => void;
}

const wsInstances = vi.hoisted<{ all: MockWsClient[] }>(() => ({ all: [] }));

/** Per-test override applied to every newly-constructed mock client's
 *  `connect()` method. Used by the pairing-flow tests to make the first
 *  N connect attempts throw GatewayPairingRequiredError without racing
 *  against the synchronous ws-construction inside login(). */
const connectOverride = vi.hoisted<{ fn: ((attempt: number) => Promise<void>) | null }>(() => ({
  fn: null,
}));

vi.mock("./ws-client", () => {
  class MockGatewayWsClient {
    connect = vi.fn<() => Promise<void>>().mockImplementation(async () => {
      if (connectOverride.fn) {
        // The argument is meaningless to pairing-loop tests, which use
        // `withAttemptCounter` (an internal closure counter — see line ~660).
        // Kept on the call signature for any non-pairing override that wants
        // the wsInstances proxy.
        await connectOverride.fn(wsInstances.all.length);
      }
    });
    close = vi.fn<() => void>();
    isConnected = vi.fn<() => boolean>().mockReturnValue(true);
    getExecutionCapabilities = () => ({
      version: 0 as const,
      maxConcurrentRuns: 1 as const,
      runCorrelation: "legacy-single-run" as const,
      cancellation: "runId" as const,
      idempotency: "idempotencyKey" as const,
      eventSequence: "transport-order" as const,
      startAck: "unspecified" as const,
    });
    request = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue({ runId: "run-test" });
    eventListeners = new Set<EventListener>();
    onEvent = vi.fn<(l: EventListener) => () => void>((l) => {
      this.eventListeners.add(l);
      return () => this.eventListeners.delete(l);
    });
    emitEvent = (eventName: string, payload: Record<string, unknown>): void => {
      for (const l of this.eventListeners) l(eventName, payload);
    };
    // Real implementation of onStateChange so tests can drive state changes.
    private stateListeners = new Set<StateChangeListener>();
    onStateChange = vi.fn<(l: StateChangeListener) => () => void>((l) => {
      this.stateListeners.add(l);
      return () => this.stateListeners.delete(l);
    });
    emitState = (state: "connecting" | "connected" | "disconnected"): void => {
      for (const l of this.stateListeners) l(state);
    };
    // Inbound RPC handler registry — used by DesktopCapabilitiesBridge.attach
    // and GatewayToolBackend.attachApprovalRouter. The handler/unregister maps
    // exist so behavioural tests can assert which `desktop.*` methods are
    // currently registered (instead of probing private bridge pointers).
    inboundHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
    inboundUnregisters = new Map<string, ReturnType<typeof vi.fn<() => void>>>();
    registerInboundHandler = vi.fn<
      (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => () => void
    >((method, handler) => {
      this.inboundHandlers.set(method, handler);
      const unreg = vi.fn<() => void>(() => {
        this.inboundHandlers.delete(method);
      });
      this.inboundUnregisters.set(method, unreg);
      return unreg;
    });
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock conforms to MockWsClient shape
      wsInstances.all.push(this as unknown as MockWsClient);
    }
  }
  // Stub error class — backend's `instanceof GatewayPairingRequiredError`
  // checks resolve through this same module, so the stub is what matches.
  class MockPairingRequiredError extends Error {
    readonly name = "GatewayPairingRequiredError";
    constructor(readonly requestId: string) {
      super(`[gateway-ws] pairing required (requestId=${requestId})`);
    }
  }
  return {
    GatewayWsClient: MockGatewayWsClient,
    GatewayPairingRequiredError: MockPairingRequiredError,
  };
});

// auth/controller.ts imports PairingCancelledError from "./pairing-cancelled-error";
// when its tests mock the WS client they don't go through this file, but
// our pairing-flow tests below import the real backend (with its own real
// PairingCancelledError), so no separate mock is needed.

// readDeviceIdentity tries to read from disk — short-circuit with a stub.
vi.mock("./device-identity", () => ({
  readDeviceIdentity: () => ({
    deviceId: "test-device",
    publicKeyBase64url: "pub",
    secretKeyBase64url: "sec",
  }),
  signChallenge: () => ({
    deviceId: "test-device",
    publicKeyBase64url: "pub",
    signatureBase64url: "sig",
    signedAt: 0,
  }),
}));

import { GatewayBackendTestAccess } from "../../test-helpers/gateway-backend-test-access";
import { testDouble } from "../../testing/harness";
import { expectBackendEvent, expectRemoteSessionEvent } from "../../testing/harness/backend-events";
import type {
  AttachApprovalRouterDeps,
  AttachDesktopCapabilitiesDeps,
  BackendEvent,
} from "../types";
import type { GatewayAutomationBackend } from "./automation/backend";
import { GatewayAutomationOrchestrator } from "./automation/orchestrator";
import { GatewaySessionBackend } from "./session";
import type { GatewayWsClient } from "./ws-client";

function makeMockClient(rpcResult: Record<string, unknown> = { runId: "run-1" }) {
  let eventListener: EventListener | null = null;
  const client = {
    onEvent: (l: EventListener) => {
      eventListener = l;
      return () => {};
    },
    onStateChange: () => () => {},
    request: vi
      .fn<(_method: string, _params: Record<string, unknown>) => Promise<Record<string, unknown>>>()
      .mockResolvedValue(rpcResult),
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    close: vi.fn<() => void>(),
    isConnected: () => true,
    getExecutionCapabilities: () => ({
      version: 0 as const,
      maxConcurrentRuns: 1 as const,
      runCorrelation: "legacy-single-run" as const,
      cancellation: "runId" as const,
      idempotency: "idempotencyKey" as const,
      eventSequence: "transport-order" as const,
      startAck: "unspecified" as const,
    }),
    // sessionsCreate delegates to request() so tests can assert on request() directly.
    async sessionsCreate(params: { label?: string; model?: string }) {
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: vi.fn mock is widened to accept real RPC args; narrowing is safe given caller's mockResolvedValue
      const callRequest = client.request as unknown as (
        method: string,
        p: { label?: string; model?: string },
      ) => Promise<{ key: string; sessionId: string }>;
      return callRequest("sessions.create", params);
    },
    // sessionsDelete delegates to request() so tests can assert on request() directly.
    async sessionsDelete(params: { key: string; deleteTranscript?: boolean }) {
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: vi.fn mock is widened to accept real RPC args; narrowing is safe given caller's mockResolvedValue
      const callRequest = client.request as unknown as (
        method: string,
        p: { key: string; deleteTranscript?: boolean },
      ) => Promise<{ ok: boolean; key: string; deleted: boolean }>;
      return callRequest("sessions.delete", params);
    },
    // chatAbort delegates to request() so tests can assert on request() directly.
    async chatAbort(params: { sessionKey: string; runId: string }) {
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: vi.fn mock is widened to accept real RPC args; narrowing is safe given caller's mockResolvedValue
      const callRequest = client.request as unknown as (
        method: string,
        p: { sessionKey: string; runId: string },
      ) => Promise<{ ok: boolean; aborted: boolean; runIds: string[] }>;
      return callRequest("chat.abort", params);
    },
    // chatHistory delegates to request() so tests can assert on request() directly.
    async chatHistory(params: { sessionKey: string; limit?: number }) {
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: vi.fn mock is widened to accept real RPC args; narrowing is safe given caller's mockResolvedValue
      const callRequest = client.request as unknown as (
        method: string,
        p: { sessionKey: string; limit?: number },
      ) => Promise<{ messages: Array<Record<string, unknown>> }>;
      return callRequest("chat.history", params);
    },
    async chatSend(params: { message: string; sessionKey: string; idempotencyKey: string }) {
      const result = await client.request("chat.send", params);
      return { runId: typeof result.runId === "string" ? result.runId : "" };
    },
    // sessionsList delegates to request() so tests can assert on request() directly.
    async sessionsList(params: { limit?: number }) {
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: vi.fn mock is widened to accept real RPC args; narrowing is safe given caller's mockResolvedValue
      const callRequest = client.request as unknown as (
        method: string,
        p: { limit?: number },
      ) => Promise<{ sessions: Array<Record<string, unknown>> }>;
      return callRequest("sessions.list", params);
    },
    // sessionsPatch delegates to request() so tests can assert on request() directly.
    async sessionsPatch(params: { key: string; label?: string; model?: string }) {
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: vi.fn mock is widened to accept real RPC args; narrowing is safe given caller's mockResolvedValue
      const callRequest = client.request as unknown as (
        method: string,
        p: { key: string; label?: string; model?: string },
      ) => Promise<{ ok: boolean }>;
      return callRequest("sessions.patch", params);
    },
    // sessionsSubscribe fires sessions.subscribe RPC then registers an event
    // listener for sessions.changed events. Returns an unsubscribe function.
    async sessionsSubscribe(
      onChange: (evt: {
        reason: "create" | "patch" | "delete" | "compact" | "reset";
        sessionKey: string;
        session?: Record<string, unknown>;
      }) => void,
    ): Promise<() => void> {
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: vi.fn mock is widened to accept real RPC args
      const callRequest = client.request as unknown as (
        method: string,
        p: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
      await callRequest("sessions.subscribe", {});
      // Register a listener that fires onChange for sessions.changed events.
      const unsub = client.onEvent((eventName, payload) => {
        if (eventName !== "sessions.changed") return;
        const reason = typeof payload.reason === "string" ? payload.reason : "";
        const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
        if (!sessionKey) return;
        if (
          reason !== "create" &&
          reason !== "patch" &&
          reason !== "delete" &&
          reason !== "compact" &&
          reason !== "reset"
        ) {
          return;
        }
        const sessionRaw =
          typeof payload.session === "object" && payload.session !== null
            ? payload.session
            : undefined;
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- sessionRaw narrowed by typeof+null check; cast narrows from object to Record for onChange parameter
        const session = sessionRaw as Record<string, unknown> | undefined;
        onChange({ reason, sessionKey, session });
      });
      return unsub;
    },
    emit(eventName: string, payload: Record<string, unknown>) {
      if (eventListener) eventListener(eventName, payload);
    },
  };
  return client;
}

function deferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("GatewaySessionBackend event dispatch", () => {
  it("dispatches turn-complete + idle to the active session when chat.final arrives", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient({ runId: "run-1" });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("session-A", "agent:test:A");

    const received: BackendEvent[] = [];
    backend.subscribe("session-A", (e) => received.push(e));

    // Start a send so the returned runId is registered in the route maps.
    await backend.send("session-A", { prompt: "hi" });

    mockClient.emit("chat", {
      runId: "run-1",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    });

    // Regression for the vanishing-message bug:
    // chat.final → [turn-complete, idle] must reach the subscriber.
    expect(received).toHaveLength(2);
    expect(expectBackendEvent(received[0], "turn-complete").message.content).toBe("Hello");
    expect(received[1].type).toBe("idle");
  });

  it("dispatches tool-start and tool-result BackendEvents when stream:'tool' agent events arrive", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient({ runId: "run-1" });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("session-A", "agent:test:A");

    const received: BackendEvent[] = [];
    backend.subscribe("session-A", (e) => received.push(e));

    await backend.send("session-A", { prompt: "ls" });

    mockClient.emit("agent", {
      runId: "run-1",
      stream: "tool",
      data: { phase: "start", name: "shell", toolCallId: "tc-1", args: { cmd: "ls" } },
    });
    mockClient.emit("agent", {
      runId: "run-1",
      stream: "tool",
      data: {
        phase: "result",
        name: "shell",
        toolCallId: "tc-1",
        isError: false,
        result: { stdout: "file" },
      },
    });
    // Symmetric to the orphan-tool-start test below: a happy-path tool turn
    // also settles via chat.final → turn-complete + idle. Pins that the
    // lifecycle doesn't wedge when tool events fire mid-turn.
    mockClient.emit("chat", {
      runId: "run-1",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });

    const startEvt = received.find((e) => e.type === "tool-start");
    expect(startEvt).toBeDefined();
    const start = expectBackendEvent(startEvt, "tool-start");
    expect(start.toolCallId).toBe("tc-1");
    expect(start.toolName).toBe("shell");
    const resultEvt = received.find((e) => e.type === "tool-result");
    expect(resultEvt).toBeDefined();
    const result = expectBackendEvent(resultEvt, "tool-result");
    expect(result.toolCallId).toBe("tc-1");
    expect(result.success).toBe(true);
    expect(received.some((e) => e.type === "turn-complete")).toBe(true);
    expect(received.some((e) => e.type === "idle")).toBe(true);
  });

  it("pins the orphan-tool-start contract: a tool-start with no matching tool-result still commits via turn-complete on chat.final", async () => {
    // Documents the current behavior so a future change is intentional:
    // when tool-start fires and chat.final arrives without a matching
    // tool-result, the subscriber observes tool-start followed by turn-complete
    // + idle. No tool-result is synthesised at this layer — the BackendEvent
    // stream is faithful to the wire. The downstream `toolCalls` array on the
    // committed message is TurnAccumulator's responsibility (SessionManager
    // layer), not the gateway backend's; marking stranded tools as
    // failed/cancelled is a separable accumulator concern. A regression that
    // reorders the events or fabricates a synthetic tool-result here breaks
    // this test.
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient({ runId: "run-1" });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("session-A", "agent:test:A");

    const received: BackendEvent[] = [];
    backend.subscribe("session-A", (e) => received.push(e));

    await backend.send("session-A", { prompt: "stuck tool" });

    mockClient.emit("agent", {
      runId: "run-1",
      stream: "tool",
      data: { phase: "start", name: "shell", toolCallId: "tc-orphan", args: { cmd: "sleep" } },
    });
    mockClient.emit("chat", {
      runId: "run-1",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });

    const toolStartIdx = received.findIndex((e) => e.type === "tool-start");
    const turnCompleteIdx = received.findIndex((e) => e.type === "turn-complete");
    const idleIdx = received.findIndex((e) => e.type === "idle");
    expect(toolStartIdx).toBeGreaterThanOrEqual(0);
    expect(turnCompleteIdx).toBeGreaterThan(toolStartIdx);
    expect(idleIdx).toBeGreaterThan(turnCompleteIdx);
    expect(received.some((e) => e.type === "tool-result")).toBe(false);
    expect(expectBackendEvent(received[turnCompleteIdx], "turn-complete").message.content).toBe(
      "done",
    );
  });

  it("throws a clear error when send() is called before init", async () => {
    const backend = new GatewaySessionBackend();
    // No attachClient called — client is null, as it is between GatewayBackend
    // construction and the first login. Renderer code paths that invoke
    // send() before auto-sign-in completes hit this branch.
    await expect(backend.send("session-A", { prompt: "hi" })).rejects.toThrow(/not connected/i);
  });

  it("events from a different session's run do not leak to another subscriber", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient({ runId: "run-A" });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("session-A", "agent:test:A");
    access.setSessionKey("session-B", "agent:test:B");

    const eventsA: BackendEvent[] = [];
    const eventsB: BackendEvent[] = [];
    backend.subscribe("session-A", (e) => eventsA.push(e));
    backend.subscribe("session-B", (e) => eventsB.push(e));

    // Session A starts a run — its runId becomes the active one.
    await backend.send("session-A", { prompt: "hello from A" });

    // Gateway emits a chat.final for A's run. Only A should receive it;
    // session B must not see any event at all.
    mockClient.emit("chat", {
      runId: "run-A",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "A response" }] },
    });

    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB).toHaveLength(0);
  });

  it("agent stream:'tool' events from one session's run do not leak to another subscriber", async () => {
    // Companion to the chat.final cross-session test above — pins that the
    // runId → sessionKey correlation also gates the agent/tool path. A future
    // dispatch refactor that drops the guard for `agent` events would leak
    // tool cards across sessions; this test fires on that.
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient({ runId: "run-A" });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("session-A", "agent:test:A");
    access.setSessionKey("session-B", "agent:test:B");

    const eventsA: BackendEvent[] = [];
    const eventsB: BackendEvent[] = [];
    backend.subscribe("session-A", (e) => eventsA.push(e));
    backend.subscribe("session-B", (e) => eventsB.push(e));

    await backend.send("session-A", { prompt: "hello from A" });

    mockClient.emit("agent", {
      runId: "run-A",
      stream: "tool",
      data: { phase: "start", name: "shell", toolCallId: "tc-A", args: { cmd: "ls" } },
    });

    expect(eventsA.some((e) => e.type === "tool-start")).toBe(true);
    expect(eventsB).toHaveLength(0);
  });

  it("continues to reject subsequent events from the completed run", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient({ runId: "run-1" });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("session-A", "agent:test:A");

    const received: BackendEvent[] = [];
    backend.subscribe("session-A", (e) => received.push(e));

    await backend.send("session-A", { prompt: "hi" });

    mockClient.emit("chat", {
      runId: "run-1",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    });

    const countAfterFinal = received.length;

    // A stray event after chat.final (same runId) should be ignored because
    // the route moved into the bounded ended-run set.
    mockClient.emit("chat", {
      runId: "run-1",
      seq: 99,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "stray" }] },
    });

    expect(received).toHaveLength(countAfterFinal);
  });
});

describe("GatewaySessionBackend event dispatch — sessionKey reverse-lookup fallback (cron-spawned runs)", () => {
  it("delivers events for runs not initiated by chat.send when sessionKey reverse-lookup hits", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient();
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("sess-cron", "agent:main:auto-x");

    const received: BackendEvent[] = [];
    backend.subscribe("sess-cron", (e) => received.push(e));

    // No tracked foreground run exists; sessionKey fallback owns this event.
    mockClient.emit("chat", {
      runId: "r-cron-1",
      sessionKey: "agent:main:auto-x",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Cron result" }] },
    });

    expect(received.some((e) => e.type === "turn-complete")).toBe(true);
    expect(
      expectBackendEvent(
        received.find((e) => e.type === "turn-complete"),
        "turn-complete",
      ).message.content,
    ).toBe("Cron result");
  });

  it("drops untracked events with an unknown sessionKey", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient();
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("sess-cron", "agent:main:auto-x");

    const received: BackendEvent[] = [];
    backend.subscribe("sess-cron", (e) => received.push(e));

    mockClient.emit("chat", {
      runId: "r-unknown",
      sessionKey: "agent:main:UNKNOWN-KEY",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Should not arrive" }] },
    });

    expect(received).toHaveLength(0);
  });

  it("does NOT pollute endedRunIds when a cron-spawned run emits turn-complete", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient();
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("sess-cron", "agent:main:auto-x");

    backend.subscribe("sess-cron", () => {});

    mockClient.emit("chat", {
      runId: "r-cron-2",
      sessionKey: "agent:main:auto-x",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });

    expect(access.syncState.localIdBySessionKey.get("agent:main:auto-x")).toBe("sess-cron");
  });

  it("routes a cron run by sessionKey without disturbing a foreground run", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient({ runId: "my-r" });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("my-sess", "agent:main:my-key");
    access.setSessionKey("sess-cron", "agent:main:auto-x");

    backend.subscribe("my-sess", () => {});
    backend.subscribe("sess-cron", () => {});

    await backend.startRun(
      "my-sess",
      { prompt: "foreground prompt" },
      { localRunId: "local-foreground" },
    );

    const cronReceived: BackendEvent[] = [];
    backend.subscribe("sess-cron", (e) => cronReceived.push(e));

    mockClient.emit("chat", {
      runId: "cron-other",
      sessionKey: "agent:main:auto-x",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "cron done" }] },
    });

    expect(cronReceived.some((event) => event.type === "turn-complete")).toBe(true);
    expect(access.getActiveLocalRunId("my-sess")).toBe("local-foreground");
  });

  it("drops untracked events with no sessionKey", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient();
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("sess-cron", "agent:main:auto-x");

    const received: BackendEvent[] = [];
    backend.subscribe("sess-cron", (e) => received.push(e));

    mockClient.emit("chat", {
      runId: "r-no-key",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "no key" }] },
    });

    expect(received).toHaveLength(0);
  });
});

describe("GatewaySessionBackend.create (RPC)", () => {
  it("calls sessions.create with label+model and returns backendId = cloud sessionId (not key)", async () => {
    // Reality check: sessionsCreate returns { key, sessionId } as DISTINCT
    // values. `key` is a routing token; `sessionId` is the stable server-
    // side identity. backendId must surface the latter.
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    mockClient.request = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue({ ok: true, key: "agent:main:abc", sessionId: "cloud-xyz" });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));

    const handle = await backend.create({
      sessionId: "local-sess-1",
      systemMessage: "",
      model: "claude-opus-4-7",
    });

    expect(handle.sessionId).toBe("local-sess-1");
    expect(handle.backendId).toBe("cloud-xyz");
    // Routing token lives in sessionKeys, keyed by local id.
    expect(new GatewayBackendTestAccess(backend).getSessionKey("local-sess-1")).toBe(
      "agent:main:abc",
    );
    expect(mockClient.request).toHaveBeenCalledWith("sessions.create", {
      label: "local-sess-1",
      model: "claude-opus-4-7",
    });
  });

  it("translates dotted Opus aliases to the canonical hyphenated form on the wire", async () => {
    // Older sessions stored model="claude-opus-4.7" (dotted UI alias) on
    // disk; the marshal adapter only recognises the hyphenated canonical
    // id. The normalize step at the gateway boundary heals legacy state
    // without touching disk or the Copilot path.
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    mockClient.request = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue({ ok: true, key: "k1", sessionId: "cloud-1" });
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock
    backend.attachClient(mockClient as unknown as GatewayWsClient);

    await backend.create({
      sessionId: "local-1",
      systemMessage: "",
      model: "claude-opus-4.7",
    });

    expect(mockClient.request).toHaveBeenCalledWith("sessions.create", {
      label: "local-1",
      model: "claude-opus-4-7",
    });
  });

  it("substitutes a supported default for non-Anthropic models instead of throwing", async () => {
    // gpt-* / gemini-* aren't on the marshal routing path — selecting one
    // would silently time out downstream. Throwing here is too disruptive
    // for routine flows (user selected the Gateway runtime, default was gpt);
    // instead, substitute and warn. The first param of sessions.create
    // gives us the wire model id — assert the substitute landed there.
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    mockClient.request = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue({ ok: true, key: "k1", sessionId: "cloud-1" });
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock
    backend.attachClient(mockClient as unknown as GatewayWsClient);

    await expect(
      backend.create({
        sessionId: "local-1",
        systemMessage: "",
        model: "gpt-5",
      }),
    ).resolves.toMatchObject({ sessionId: "local-1", backendId: "cloud-1" });
    expect(mockClient.request).toHaveBeenCalledWith("sessions.create", {
      label: "local-1",
      model: "claude-opus-4-7",
    });
  });

  it("allows undefined model — gateway picks its own default", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    mockClient.request = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue({ ok: true, key: "k1", sessionId: "cloud-1" });
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock
    backend.attachClient(mockClient as unknown as GatewayWsClient);

    await expect(
      backend.create({ sessionId: "local-1", systemMessage: "" }),
    ).resolves.toMatchObject({ sessionId: "local-1", backendId: "cloud-1" });
  });

  it("throws if called before attachClient", async () => {
    const backend = new GatewaySessionBackend();
    await expect(backend.create({ sessionId: "sess-1", systemMessage: "" })).rejects.toThrow(
      /not connected/i,
    );
  });

  it("returns cached handle without re-calling RPC when sessionKey already set (idempotence)", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    mockClient.request = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue({ ok: true, key: "agent:main:first", sessionId: "cloud-first" });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));

    const first = await backend.create({ sessionId: "local-1", systemMessage: "" });
    expect(first.backendId).toBe("cloud-first");
    expect(mockClient.request).toHaveBeenCalledTimes(1);

    // Second call for the same sessionId — should be a no-op on the wire and
    // return the same cached handle, not spin up a second cloud session.
    const second = await backend.create({ sessionId: "local-1", systemMessage: "" });
    expect(second.backendId).toBe("cloud-first");
    expect(mockClient.request).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent create() calls for the same sessionId (race)", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    // Resolve the RPC only after both create() calls have entered — that's
    // the concurrency race we want to defend against. Before this fix, both
    // would see an empty sessionKeys map and each fire their own RPC.
    let resolveRpc!: (v: Record<string, unknown>) => void;
    mockClient.request = vi.fn<() => Promise<Record<string, unknown>>>().mockReturnValue(
      new Promise<Record<string, unknown>>((r) => {
        resolveRpc = r;
      }),
    );
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));

    const a = backend.create({ sessionId: "local-1", systemMessage: "" });
    const b = backend.create({ sessionId: "local-1", systemMessage: "" });
    // Both promises exist before the RPC resolves.
    resolveRpc({ ok: true, key: "agent:main:only", sessionId: "cloud-only" });
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra.backendId).toBe("cloud-only");
    expect(rb.backendId).toBe("cloud-only");
    // Only one server-side sessions.create RPC should have fired.
    expect(mockClient.request).toHaveBeenCalledTimes(1);
  });

  it("recovers from 'label already in use' by reconciling via sessions.list", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    const dispatching = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockImplementation(async (...args: unknown[]) => {
        const method = args[0];
        if (method === "sessions.create") {
          throw new Error("[gateway-ws] label already in use: local-resurrect");
        }
        if (method === "sessions.list") {
          return {
            sessions: [
              {
                key: "agent:main:resurrect",
                sessionId: "cloud-resurrect",
                label: "local-resurrect",
              },
              { key: "agent:main:other", sessionId: "cloud-other", label: "local-other" },
            ],
          };
        }
        return { ok: true };
      });
    mockClient.request = dispatching;
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));

    const handle = await backend.create({
      sessionId: "local-resurrect",
      systemMessage: "",
      model: "claude-opus-4-7",
    });

    expect(handle.sessionId).toBe("local-resurrect");
    expect(handle.backendId).toBe("cloud-resurrect");
    const access = new GatewayBackendTestAccess(backend);
    expect(access.getSessionKey("local-resurrect")).toBe("agent:main:resurrect");
    expect(access.getBackendId("local-resurrect")).toBe("cloud-resurrect");
    const calls = (mockClient.request as ReturnType<typeof vi.fn>).mock.calls.map(
      ([method]) => method,
    );
    expect(calls).toContain("sessions.create");
    expect(calls).toContain("sessions.list");
  });

  it("surfaces the original 'label already in use' error when sessions.list yields no matching label", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    const dispatching = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockImplementation(async (...args: unknown[]) => {
        const method = args[0];
        if (method === "sessions.create") {
          throw new Error("[gateway-ws] label already in use: local-missing");
        }
        if (method === "sessions.list") {
          return { sessions: [{ key: "k", sessionId: "s", label: "different-session" }] };
        }
        return { ok: true };
      });
    mockClient.request = dispatching;
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));

    await expect(
      backend.create({
        sessionId: "local-missing",
        systemMessage: "",
        model: "claude-opus-4-7",
      }),
    ).rejects.toThrow(/label already in use/i);
    const calls = (mockClient.request as ReturnType<typeof vi.fn>).mock.calls.map(
      ([method]) => method,
    );
    expect(calls).toContain("sessions.create");
    expect(calls).toContain("sessions.list");
  });

  it("surfaces the original 'label already in use' error when sessions.list itself throws during recovery", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    const dispatching = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockImplementation(async (...args: unknown[]) => {
        const method = args[0];
        if (method === "sessions.create") {
          throw new Error("[gateway-ws] label already in use: local-blown");
        }
        if (method === "sessions.list") {
          throw new Error("[gateway-ws] transient network blip");
        }
        return { ok: true };
      });
    mockClient.request = dispatching;
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));

    await expect(
      backend.create({
        sessionId: "local-blown",
        systemMessage: "",
        model: "claude-opus-4-7",
      }),
    ).rejects.toThrow(/label already in use/i);
  });
});

import type { GatewayAuthIdentity } from "../../../common/marshal-ipc-contract";
import type { HostedRuntimeProvider } from "../../hosted-runtime/contracts";
import { GatewayBackend } from "./provider";
// GatewayAutomationOrchestrator imported above for orchestrator tests

function testHostedRuntime(
  acquireAuthToken: () => Promise<string | undefined>,
): HostedRuntimeProvider {
  return {
    id: "test",
    resolveEndpoint: () => ({ url: "wss://gateway.test", sharedToken: "test-token" }),
    acquireAuthToken,
    resolveDeviceIdentityPath: (defaultPath) => defaultPath,
  };
}

describe("GatewayBackend.login", () => {
  // We can't drive a real WebSocket in unit tests. Instead, verify token
  // construction by stubbing the low-level client via a subclass hook.
  // Those subclass hooks live on GatewayBackend — if they don't exist yet,
  // this test will fail with "buildAuthToken is not a function", which is
  // the intended red.
  it("no-auth mode builds a null token", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/tmp/nonexistent",
      gatewayToken: "test-token",
    });
    const cred: GatewayAuthIdentity = { mode: "no-auth" };
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any -- accessing private helper
    expect(await (backend as any).buildAuthToken(cred)).toBeUndefined();
  });

  it("hosted mode acquires the gateway token from the hosted runtime provider", async () => {
    const acquireWeaveToken = vi.fn<() => Promise<string>>().mockResolvedValue("weave-token-xyz");
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/tmp/nonexistent",
      gatewayToken: "test-token",
      hostedRuntime: testHostedRuntime(acquireWeaveToken),
    });
    const cred: GatewayAuthIdentity = { mode: "hosted" };
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any -- accessing private helper
    const token = await (backend as any).buildAuthToken(cred);
    expect(token).toBe("weave-token-xyz");
    expect(acquireWeaveToken).toHaveBeenCalledTimes(1);
  });
});

describe("GatewayBackend.login (public wrapper)", () => {
  beforeEach(() => {
    wsInstances.all = [];
  });

  function newBackend() {
    return new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/tmp/device-identity.json",
      gatewayToken: "test-token",
    });
  }

  it("creates a client with no authToken for no-auth mode", async () => {
    const backend = newBackend();
    await backend.login({ mode: "no-auth" });

    expect(wsInstances.all[0].config.authToken).toBeUndefined();
  });

  it("closes the previous client on subsequent login (no listener leak)", async () => {
    // Without close-on-relogin, every signIn → signOut → signIn cycle would
    // accumulate live onEvent + onStateChange subscribers for the lifetime of
    // the process, doubling the event-handler count on each re-login.
    const backend = newBackend();
    await backend.login({ mode: "no-auth" });
    await backend.login({ mode: "no-auth" });
    expect(wsInstances.all[0].close).toHaveBeenCalled();
    expect(wsInstances.all).toHaveLength(2);
  });

  it("signOut closes the active client and isReady() returns false", async () => {
    const backend = newBackend();
    await backend.login({ mode: "no-auth" });
    expect(backend.isReady()).toBe(true);
    await backend.signOut();
    expect(wsInstances.all[0].close).toHaveBeenCalled();
    expect(backend.isReady()).toBe(false);
  });

  it("signOut clears lastAuthToken — a subsequent no-auth login carries no leftover bearer", async () => {
    // Behavioral pin against a token-bleed regression: if `this.lastAuthToken
    // = undefined` is ever removed from signOut, the next no-auth login's
    // ws-client would inherit the prior bearer token (e.g. an AAD reconnect
    // racing stopReconnect could persist a stale credential). The reconnect
    // path is verified to preserve lastAuthToken across a disconnect — this
    // pins the *clearing* contract on signOut.
    const acquireWeaveToken = vi.fn<() => Promise<string>>().mockResolvedValue("aad-token-1");
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/tmp/device-identity.json",
      gatewayToken: "test-token",
      hostedRuntime: testHostedRuntime(acquireWeaveToken),
    });
    await backend.login({ mode: "hosted" });
    expect(wsInstances.all[0].config.authToken).toBe("aad-token-1");
    await backend.signOut();
    await backend.login({ mode: "no-auth" });
    expect(wsInstances.all[wsInstances.all.length - 1].config.authToken).toBeUndefined();
  });
});

describe("GatewayBackend pairing flow", () => {
  beforeEach(() => {
    wsInstances.all = [];
    connectOverride.fn = null;
  });
  afterEach(() => {
    connectOverride.fn = null;
  });

  function newBackend() {
    return new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/tmp/device-identity.json",
      gatewayToken: "test-token",
    });
  }

  // Resolves the stub error class from the same mocked module as the
  // backend, so the backend's `instanceof GatewayPairingRequiredError`
  // check matches the throw site.
  async function getPairingError(): Promise<new (id: string) => Error> {
    const wsModule: { GatewayPairingRequiredError: new (id: string) => Error } =
      await import("./ws-client");
    return wsModule.GatewayPairingRequiredError;
  }

  /** Per-test attempt counter — closure over the override function rather
   *  than `wsInstances.all.length` (which is a proxy that breaks if the
   *  backend ever reuses a ws client across retries). */
  function withAttemptCounter(
    fn: (attempt: number) => Promise<void>,
  ): (ignoredArg: number) => Promise<void> {
    let attempt = 0;
    return async () => {
      attempt++;
      await fn(attempt);
    };
  }

  /** Run all currently-queued microtasks repeatedly until the queue settles.
   *  Necessary because login() chains ~5 awaits before runPairingLoop's body
   *  runs and the pairing-status callback fires; counting individual flushes
   *  is brittle across refactors. */
  async function flushMicrotasks(times = 20): Promise<void> {
    for (let i = 0; i < times; i++) {
      await Promise.resolve(); // oxlint-disable-line no-await-in-loop -- intentional sequential drain
    }
  }

  /** Convert a promise into a settled result so the test can attach a no-op
   *  rejection handler immediately and avoid Node's unhandled-rejection
   *  warning when the promise rejects between flushes and the await on
   *  expect(...).rejects fires. */
  function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
    return p.then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err }),
    );
  }

  it("invokes the pairing-status callback with the requestId, retries connect, and succeeds when the loop's next attempt resolves", async () => {
    vi.useFakeTimers();
    try {
      const ErrorCtor = await getPairingError();
      const backend = newBackend();
      const onPairing = vi.fn<(id: string) => void>();
      backend.setPairingStatusCallback(onPairing);

      // First connect attempt throws pairing-required, second resolves.
      connectOverride.fn = withAttemptCounter(async (attempt) => {
        if (attempt === 1) throw new ErrorCtor("req-pair-1");
      });

      const loginPromise = backend.login({ mode: "no-auth" });
      await flushMicrotasks();
      expect(onPairing).toHaveBeenCalledWith("req-pair-1");
      // Advance past the 5s sleep; second attempt runs and resolves.
      await vi.advanceTimersByTimeAsync(5_000);
      await loginPromise;
      expect(backend.isReady()).toBe(true);
      expect(onPairing).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-fires the pairing-status callback when the gateway rotates the requestId mid-loop", async () => {
    // Defensive against a server-side TTL expiry that mints a fresh request
    // while the client is still waiting — the renderer should see the new id.
    vi.useFakeTimers();
    try {
      const ErrorCtor = await getPairingError();
      const backend = newBackend();
      const onPairing = vi.fn<(id: string) => void>();
      backend.setPairingStatusCallback(onPairing);

      connectOverride.fn = withAttemptCounter(async (attempt) => {
        if (attempt === 1) throw new ErrorCtor("req-pair-original");
        if (attempt === 2) throw new ErrorCtor("req-pair-rotated");
        // attempt === 3 resolves — pairing approved
      });

      const loginPromise = backend.login({ mode: "no-auth" });
      await flushMicrotasks();
      expect(onPairing).toHaveBeenCalledWith("req-pair-original");
      // Second attempt: gateway returned a different requestId → the loop
      // logs the rotation and re-fires the status callback so the renderer
      // can show the new id.
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
      expect(onPairing).toHaveBeenCalledWith("req-pair-rotated");
      // Third attempt resolves — pairing approved.
      await vi.advanceTimersByTimeAsync(5_000);
      await loginPromise;
      expect(onPairing).toHaveBeenCalledTimes(2);
      expect(backend.isReady()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with 'Pairing timed out' when the wait window elapses, and clears pairingWait so a follow-up login can run", async () => {
    // 5-min wait window matches the runtime's pending-request TTL; once
    // the deadline lapses login() must reject AND release the pairingWait
    // lock so subsequent login()s aren't permanently rejected as "in flight".
    vi.useFakeTimers();
    try {
      const ErrorCtor = await getPairingError();
      const backend = newBackend();
      // Always throw pairing-required — the loop never reaches success.
      connectOverride.fn = async () => {
        throw new ErrorCtor("req-pair-timeout");
      };

      const firstLogin = settle(backend.login({ mode: "no-auth" }));
      await flushMicrotasks();
      // Advance past the 5min deadline. ~60 retry ticks plus a bit of slack
      // so the deadline check fires after the final sleep.
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
      const r = await firstLogin;
      expect(r.ok).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by ok=false above
      expect((r as { err: Error }).err.message).toMatch(/Pairing timed out/);
      expect(backend.isReady()).toBe(false);

      // Now a new login() should succeed (pairingWait was released by the
      // finally block in runPairingLoop).
      connectOverride.fn = async () => {}; // success on first attempt
      await backend.login({ mode: "no-auth" });
      expect(backend.isReady()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancelPairing aborts an in-flight pairing wait, login() rejects with 'Pairing cancelled', and a follow-up login can succeed", async () => {
    vi.useFakeTimers();
    try {
      const ErrorCtor = await getPairingError();
      const backend = newBackend();
      // Always throw pairing-required so the loop never naturally exits.
      connectOverride.fn = async () => {
        throw new ErrorCtor("req-cancel");
      };

      const firstLogin = settle(backend.login({ mode: "no-auth" }));
      await flushMicrotasks();
      // Loop is now sleeping — flip the abort, then let the timer fire.
      backend.cancelPairing();
      await vi.advanceTimersByTimeAsync(5_000);
      const r = await firstLogin;
      expect(r.ok).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by ok=false above
      expect((r as { err: Error }).err.message).toMatch(/Pairing cancelled/);
      expect(backend.isReady()).toBe(false);

      // Subsequent login() must work — the cancelled pairingWait was released.
      connectOverride.fn = async () => {};
      await backend.login({ mode: "no-auth" });
      expect(backend.isReady()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("signOut also aborts an in-flight pairing wait and leaves the backend in a clean (ready=false) state for the next login", async () => {
    vi.useFakeTimers();
    try {
      const ErrorCtor = await getPairingError();
      const backend = newBackend();
      connectOverride.fn = async () => {
        throw new ErrorCtor("req-signout");
      };

      const firstLogin = settle(backend.login({ mode: "no-auth" }));
      await flushMicrotasks();
      // signOut is a superset of cancelPairing — it also tears down the
      // active client and clears auth state.
      await backend.signOut();
      await vi.advanceTimersByTimeAsync(5_000);
      const r = await firstLogin;
      expect(r.ok).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by ok=false above
      expect((r as { err: Error }).err.message).toMatch(/Pairing cancelled/);
      expect(backend.isReady()).toBe(false);

      // Next login() should not be blocked by the previous pairingWait.
      connectOverride.fn = async () => {};
      await backend.login({ mode: "no-auth" });
      expect(backend.isReady()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GatewaySessionBackend clearSessionKeys", () => {
  it("clearSessionKeys empties the map", () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    access.setSessionKey("sess-1", "k1");
    access.setSessionKey("sess-2", "k2");
    backend.clearSessionKeys();
    expect(access.getSessionKey("sess-1")).toBeUndefined();
    expect(access.getSessionKey("sess-2")).toBeUndefined();
  });
});

describe("GatewaySessionBackend.send (sessionKey wiring)", () => {
  it("uses the real sessionKey from the map", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient({ runId: "r1" });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("sess-1", "agent:main:real");

    await backend.send("sess-1", { prompt: "hi" });

    expect(mockClient.request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({ sessionKey: "agent:main:real", message: "hi" }),
    );
  });

  it("throws a clear error when sessionKey is missing", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    // no setSessionKey call
    await expect(backend.send("sess-1", { prompt: "hi" })).rejects.toThrow(/no sessionKey/i);
  });
});

describe("GatewaySessionBackend.destroy (RPC)", () => {
  it("calls sessions.delete with deleteTranscript:true and clears sessionKeys entry", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient();
    mockClient.request = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue({ ok: true, key: "k1", deleted: true });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("sess-1", "k1");

    await backend.destroy("sess-1");

    expect(mockClient.request).toHaveBeenCalledWith("sessions.delete", {
      key: "k1",
      deleteTranscript: true,
    });
    expect(access.getSessionKey("sess-1")).toBeUndefined();
  });

  it("resolves without calling RPC when sessionKey missing (best-effort local delete)", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    await expect(backend.destroy("unknown")).resolves.toBeUndefined();
    expect(mockClient.request).not.toHaveBeenCalled();
  });

  it("resolves without RPC when client disconnected, and clears stale sessionKeys entry", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    // no attachClient — client is null (e.g. mid-reconnect / signed out)
    access.setSessionKey("sess-1", "k1");
    await expect(backend.destroy("sess-1")).resolves.toBeUndefined();
    expect(access.getSessionKey("sess-1")).toBeUndefined();
  });

  it("throws on RPC failure and keeps sessionKeys entry intact (for retry)", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient();
    mockClient.request = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockRejectedValue(new Error("gateway error"));
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("sess-1", "k1");

    await expect(backend.destroy("sess-1")).rejects.toThrow(/gateway error/);
    expect(access.getSessionKey("sess-1")).toBe("k1");
  });

  it("forgetSession clears all three sync maps (no backendIds leak)", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient();
    mockClient.request = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue({ ok: true, key: "agent:main:abc", deleted: true });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));

    // Seed all three maps, then destroy. All three entries must be gone.
    access.seedSession("local-1", "agent:main:abc", "cloud-xyz");
    expect(access.getSessionKey("local-1")).toBe("agent:main:abc");
    expect(access.getBackendId("local-1")).toBe("cloud-xyz");
    expect(access.syncState.localIdBySessionKey.get("agent:main:abc")).toBe("local-1");

    await backend.destroy("local-1");

    expect(access.getSessionKey("local-1")).toBeUndefined();
    expect(access.getBackendId("local-1")).toBeUndefined();
    expect(access.syncState.localIdBySessionKey.get("agent:main:abc")).toBeUndefined();
  });
});

describe("GatewaySessionBackend.abort (RPC)", () => {
  it("calls chat.abort with sessionKey + runId (fire-and-forget)", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient({ runId: "run-X" });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("sess-1", "k1");

    // Start a send to establish the exact run route.
    await backend.send("sess-1", { prompt: "hi" });
    mockClient.request = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue({ ok: true, aborted: true, runIds: ["run-X"] });

    await backend.abort("sess-1");

    expect(mockClient.request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: "k1",
      runId: "run-X",
    });
  });

  it("surfaces abort RPC rejection after fencing the exact run", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient({ runId: "r1" });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("sess-1", "k1");
    await backend.send("sess-1", { prompt: "hi" });

    mockClient.request = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockRejectedValue(new Error("offline"));

    await expect(backend.abort("sess-1")).rejects.toThrow("offline");
  });

  it("does not call chat.abort when no exact run is tracked", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient();
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("sess-1", "k1");
    // No send() means there is no runId that can be cancelled safely.

    await backend.abort("sess-1");

    expect(mockClient.request).not.toHaveBeenCalled();
  });
});

describe("GatewaySessionBackend.getHistory (RPC)", () => {
  it("calls chat.history with sessionKey+limit and normalizes messages", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    mockClient.request = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
      sessionKey: "k1",
      sessionId: "sess-1",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
        {
          role: "assistant",
          content: [{ type: "text", text: "world" }],
          timestamp: 2000,
        },
      ],
    });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    new GatewayBackendTestAccess(backend).setSessionKey("sess-1", "k1");

    const res = await backend.getHistory("sess-1");

    expect(mockClient.request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "k1",
      limit: 200,
    });
    expect(res).toHaveLength(2);
    expect(res[0].content).toBe("hello");
    expect(res[1].content).toBe("world");
  });

  it("throws when sessionKey missing", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    await expect(backend.getHistory("unknown")).rejects.toThrow(/no sessionKey/i);
  });

  it("propagates the malformed-response error from chat.history (bad shape)", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    // Override chatHistory on the mock to simulate the typed helper's
    // GatewayProtocolError throw on a response missing `messages`. (The real
    // helper is covered by gateway-ws-client.test.ts; this asserts that
    // backend.getHistory does not swallow the rejection.)
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion -- test-only override
    (mockClient as any).chatHistory = vi
      .fn<() => Promise<{ messages: Array<Record<string, unknown>> }>>()
      .mockRejectedValue(new Error("[gateway-ws] Protocol error on chat.history: ..."));
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    new GatewayBackendTestAccess(backend).setSessionKey("sess-1", "k1");
    await expect(backend.getHistory("sess-1")).rejects.toThrow(/chat\.history/);
  });
});

describe("GatewaySessionBackend.resume — process-restart hydration", () => {
  it("hydrates sessionKey via sessions.list when only backendId is known and the cloud row exists", async () => {
    // Reproduces the post-process-restart scenario: in-memory syncState is
    // empty, but the disk metadata has a backendId. Resume should reconcile
    // via sessions.list rather than throwing — otherwise SessionManager
    // falls back to create() which then fails with "label already in use".
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    mockClient.request = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
      sessions: [
        // Cloud row matching the backendId we're trying to resume.
        { key: "cloud-key-xyz", sessionId: "cloud-id-1", updatedAt: 1000 },
      ],
    });
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock
    backend.attachClient(mockClient as unknown as GatewayWsClient);

    const handle = await backend.resume("local-1", {
      sessionId: "local-1",
      backendId: "cloud-id-1",
      systemMessage: "",
    });

    expect(handle).toEqual({ sessionId: "local-1", backendId: "cloud-id-1" });
    expect(mockClient.request).toHaveBeenCalledWith("sessions.list", { limit: 500 });

    // sessionKey is now mirrored under the local id so subsequent send()
    // / getHistory() lookups don't have to reconcile again.
    const access = new GatewayBackendTestAccess(backend);
    expect(access.getSessionKey("local-1")).toBe("cloud-key-xyz");
  });

  it("only reconciles once per WS connection — second resume hits the cache without re-listing", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    mockClient.request = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
      sessions: [
        { key: "k1", sessionId: "cloud-1", updatedAt: 1 },
        { key: "k2", sessionId: "cloud-2", updatedAt: 2 },
      ],
    });
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock
    backend.attachClient(mockClient as unknown as GatewayWsClient);

    await backend.resume("local-1", {
      sessionId: "local-1",
      backendId: "cloud-1",
      systemMessage: "",
    });
    await backend.resume("local-2", {
      sessionId: "local-2",
      backendId: "cloud-2",
      systemMessage: "",
    });

    // sessions.list ran exactly once even though two resumes followed.
    expect(mockClient.request).toHaveBeenCalledTimes(1);
  });

  it("still throws when the backendId is unknown to the gateway (cloud row was deleted)", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    mockClient.request = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue({ sessions: [] });
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock
    backend.attachClient(mockClient as unknown as GatewayWsClient);

    await expect(
      backend.resume("local-1", {
        sessionId: "local-1",
        backendId: "ghost-cloud-id",
        systemMessage: "",
      }),
    ).rejects.toThrow(/no sessionKey/i);
  });

  it("throws without attempting reconcile when no backendId is provided (nothing to look up)", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    mockClient.request = vi.fn<() => Promise<Record<string, unknown>>>();
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock
    backend.attachClient(mockClient as unknown as GatewayWsClient);

    await expect(
      backend.resume("local-1", { sessionId: "local-1", systemMessage: "" }),
    ).rejects.toThrow(/no sessionKey/i);
    expect(mockClient.request).not.toHaveBeenCalled();
  });

  it("falls through to throwing when the in-memory cache already has a key (no list reconcile needed)", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    mockClient.request = vi.fn<() => Promise<Record<string, unknown>>>();
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock
    backend.attachClient(mockClient as unknown as GatewayWsClient);
    new GatewayBackendTestAccess(backend).setSessionKey("local-1", "pre-cached-key");

    const handle = await backend.resume("local-1", {
      sessionId: "local-1",
      backendId: "cloud-1",
      systemMessage: "",
    });
    expect(handle).toEqual({ sessionId: "local-1", backendId: "cloud-1" });
    expect(mockClient.request).not.toHaveBeenCalled();
  });

  it("clearSessionKeys resets the listReconciled flag so the next resume re-reconciles", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    mockClient.request = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
      sessions: [{ key: "k1", sessionId: "cloud-1", updatedAt: 1 }],
    });
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock
    backend.attachClient(mockClient as unknown as GatewayWsClient);

    await backend.resume("local-1", {
      sessionId: "local-1",
      backendId: "cloud-1",
      systemMessage: "",
    });
    expect(mockClient.request).toHaveBeenCalledTimes(1);

    backend.clearSessionKeys();
    await backend.resume("local-1", {
      sessionId: "local-1",
      backendId: "cloud-1",
      systemMessage: "",
    });
    // Sign-out cleared the cache, so the second resume reconciles again.
    expect(mockClient.request).toHaveBeenCalledTimes(2);
  });
});

import { GatewayToolBackend } from "./tools";

describe("GatewayToolBackend.listModels (RPC)", () => {
  it("returns empty array when client not attached (keeps UI graceful)", async () => {
    const toolBackend = new GatewayToolBackend();
    const res = await toolBackend.listModels();
    expect(res).toEqual([]);
  });

  it("fetches + caches models (cache hit within TTL does not re-fetch)", async () => {
    const modelsList = vi
      .fn<() => Promise<{ models: Array<{ id: string; name: string }> }>>()
      .mockResolvedValue({ models: [{ id: "gpt-5", name: "GPT-5" }] });
    const toolBackend = new GatewayToolBackend();
    toolBackend.attachClient(
      testDouble<GatewayWsClient>({
        isConnected: () => true,
        modelsList,
      }),
    );

    const a = await toolBackend.listModels();
    const b = await toolBackend.listModels();
    expect(a).toEqual(b);
    expect(modelsList).toHaveBeenCalledTimes(1);
    expect(toolBackend.getCachedModels()).toEqual(a);
  });

  it("cache is invalidated when attachClient is called with a new client (sign out + sign in)", async () => {
    const firstFetch = vi
      .fn<() => Promise<{ models: Array<{ id: string; name: string }> }>>()
      .mockResolvedValue({ models: [{ id: "gpt-5", name: "GPT-5" }] });
    const toolBackend = new GatewayToolBackend();
    toolBackend.attachClient(
      testDouble<GatewayWsClient>({
        isConnected: () => true,
        modelsList: firstFetch,
      }),
    );
    await toolBackend.listModels();
    expect(firstFetch).toHaveBeenCalledTimes(1);

    const secondFetch = vi
      .fn<() => Promise<{ models: Array<{ id: string; name: string }> }>>()
      .mockResolvedValue({ models: [{ id: "gpt-6", name: "GPT-6" }] });
    toolBackend.attachClient(
      testDouble<GatewayWsClient>({
        isConnected: () => true,
        modelsList: secondFetch,
      }),
    );

    const res = await toolBackend.listModels();
    expect(secondFetch).toHaveBeenCalledTimes(1); // must not reuse stale cache
    expect(res[0].id).toBe("gpt-6");
  });

  it("TTL expiry triggers a re-fetch", async () => {
    const modelsList = vi.fn<() => Promise<{ models: Array<{ id: string; name: string }> }>>();
    modelsList.mockResolvedValueOnce({ models: [{ id: "gpt-5", name: "GPT-5" }] });
    modelsList.mockResolvedValueOnce({ models: [{ id: "gpt-5-new", name: "GPT-5 (refreshed)" }] });
    const toolBackend = new GatewayToolBackend();
    toolBackend.attachClient(
      testDouble<GatewayWsClient>({
        isConnected: () => true,
        modelsList,
      }),
    );

    const first = await toolBackend.listModels();
    expect(first[0].id).toBe("gpt-5");
    expect(modelsList).toHaveBeenCalledTimes(1);

    // Advance past the 5-minute TTL. vi.useFakeTimers isn't set up here so we
    // spy on Date.now to shift time forward.
    const realNow = Date.now;
    const fakeNow = realNow() + 5 * 60 * 1000 + 1;
    const spy = vi.spyOn(Date, "now").mockReturnValue(fakeNow);
    try {
      const second = await toolBackend.listModels();
      expect(second[0].id).toBe("gpt-5-new");
      expect(modelsList).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("detachClient clears the client and the cache", async () => {
    const modelsList = vi
      .fn<() => Promise<{ models: Array<{ id: string; name: string }> }>>()
      .mockResolvedValue({ models: [{ id: "gpt-5", name: "GPT-5" }] });
    const toolBackend = new GatewayToolBackend();
    toolBackend.attachClient(
      testDouble<GatewayWsClient>({
        isConnected: () => true,
        modelsList,
      }),
    );
    await toolBackend.listModels();
    expect(toolBackend.getCachedModels()).not.toBeNull();

    toolBackend.detachClient();
    expect(toolBackend.getCachedModels()).toBeNull();
    // After detach, listModels returns empty (no client) — doesn't throw.
    expect(await toolBackend.listModels()).toEqual([]);
  });
});

describe("GatewayToolBackend.attachApprovalRouter", () => {
  // The real impl registers desktop.evaluateLocalPolicy + desktop.showApprovalCard
  // inbound WS handlers, retains the deps across reconnects (so a fresh client
  // re-registers without main.ts re-running attachApprovalRouter), and the
  // detach fn returned to main.ts both unregisters the handlers and drops the
  // deps so a stale handler can't fire after sign-out.

  /** Stand-in for GatewayWsClient that captures inbound handler registrations. */
  function makeFakeClient() {
    const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
    const unregisters = new Map<string, ReturnType<typeof vi.fn<() => void>>>();
    return {
      handlers,
      unregisters,
      registerInboundHandler: vi.fn<
        (
          method: string,
          handler: (params: Record<string, unknown>) => Promise<unknown>,
        ) => () => void
      >((method, handler) => {
        handlers.set(method, handler);
        const unreg = vi.fn<() => void>(() => {
          handlers.delete(method);
        });
        unregisters.set(method, unreg);
        return unreg;
      }),
    };
  }

  function fakeDeps(): AttachApprovalRouterDeps {
    return {
      broker: testDouble<AttachApprovalRouterDeps["broker"]>({
        requestPrompt: vi
          .fn<AttachApprovalRouterDeps["broker"]["requestPrompt"]>()
          .mockResolvedValue({ outcome: "resolved", action: "allow" }),
      }),
      policy: testDouble<AttachApprovalRouterDeps["policy"]>({
        evaluate: vi.fn<AttachApprovalRouterDeps["policy"]["evaluate"]>(() => "approve"),
        recordInteractiveOutcome: vi.fn<
          AttachApprovalRouterDeps["policy"]["recordInteractiveOutcome"]
        >(() => true),
      }),
      classifier: testDouble<AttachApprovalRouterDeps["classifier"]>({}),
      canShowUI: () => true,
    };
  }

  it("registers desktop.evaluateLocalPolicy and desktop.showApprovalCard on the WS client", () => {
    const tools = new GatewayToolBackend();
    const client = makeFakeClient();
    tools.attachClient(testDouble<GatewayWsClient>(client));

    tools.attachApprovalRouter(fakeDeps());

    expect(client.handlers.has("desktop.evaluateLocalPolicy")).toBe(true);
    expect(client.handlers.has("desktop.showApprovalCard")).toBe(true);
  });

  it("detach fn unregisters both handlers and drops the deps", () => {
    const tools = new GatewayToolBackend();
    const client = makeFakeClient();
    tools.attachClient(testDouble<GatewayWsClient>(client));

    const detach = tools.attachApprovalRouter(fakeDeps());
    expect(client.handlers.size).toBe(2);

    detach();

    expect(client.unregisters.get("desktop.evaluateLocalPolicy")).toHaveBeenCalledOnce();
    expect(client.unregisters.get("desktop.showApprovalCard")).toHaveBeenCalledOnce();
    expect(client.handlers.size).toBe(0);

    // Deps cleared: a subsequent attachClient with a fresh client must NOT
    // re-register handlers because main.ts already detached.
    const client2 = makeFakeClient();
    tools.attachClient(testDouble<GatewayWsClient>(client2));
    expect(client2.handlers.size).toBe(0);
  });

  it("re-attachClient re-registers the handlers on the fresh client (reconnect path)", () => {
    const tools = new GatewayToolBackend();
    const client1 = makeFakeClient();
    tools.attachClient(testDouble<GatewayWsClient>(client1));
    tools.attachApprovalRouter(fakeDeps());
    expect(client1.handlers.size).toBe(2);

    // Reconnect path: init() runs again with a fresh client. The deps from the
    // earlier attachApprovalRouter call survive — handlers must register on
    // the new socket without main.ts re-running attachApprovalRouter.
    const client2 = makeFakeClient();
    tools.attachClient(testDouble<GatewayWsClient>(client2));

    expect(client2.handlers.has("desktop.evaluateLocalPolicy")).toBe(true);
    expect(client2.handlers.has("desktop.showApprovalCard")).toBe(true);
  });

  it("attachApprovalRouter before any attachClient defers registration until a client attaches", () => {
    const tools = new GatewayToolBackend();
    // No attachClient yet — call attachApprovalRouter first (mirrors main.ts
    // wiring order, where attachApprovalRouter may run before backend.init()).
    tools.attachApprovalRouter(fakeDeps());

    const client = makeFakeClient();
    tools.attachClient(testDouble<GatewayWsClient>(client));

    expect(client.handlers.has("desktop.evaluateLocalPolicy")).toBe(true);
    expect(client.handlers.has("desktop.showApprovalCard")).toBe(true);
  });

  it("registered desktop.evaluateLocalPolicy handler routes through PermissionPolicy.evaluate", async () => {
    const tools = new GatewayToolBackend();
    const client = makeFakeClient();
    tools.attachClient(testDouble<GatewayWsClient>(client));

    const deps = fakeDeps();
    tools.attachApprovalRouter(deps);

    const handler = client.handlers.get("desktop.evaluateLocalPolicy");
    expect(handler).toBeDefined();
    const result = await handler!({
      kind: "shell",
      toolName: "shell",
      sessionId: "s-1",
    });
    expect(result).toEqual({ action: "approve" });
    expect(deps.policy.evaluate).toHaveBeenCalledTimes(1);
  });

  it("registered desktop.showApprovalCard handler routes through ApprovalBroker.requestPrompt", async () => {
    // Mirror of the evaluateLocalPolicy end-to-end test: a regression where
    // `registerApprovalRouterHandlers` swapped the two methods (or wired the
    // wrong handler factory) wouldn't be caught without this. Drives the
    // registered handler and asserts the broker received the request.
    const tools = new GatewayToolBackend();
    const client = makeFakeClient();
    tools.attachClient(testDouble<GatewayWsClient>(client));

    const deps = fakeDeps();
    vi.mocked(deps.policy.evaluate).mockReturnValue("prompt");
    tools.attachApprovalRouter(deps);

    const handler = client.handlers.get("desktop.showApprovalCard");
    expect(handler).toBeDefined();
    const result = await handler!({
      requestId: "req-1",
      sessionId: "s-1",
      kind: "shell",
      toolName: "shell",
    });
    expect(result).toEqual({ action: "approve" });
    expect(deps.broker.requestPrompt).toHaveBeenCalledTimes(1);
  });

  it("detachClient unregisters approval-router handlers (no stale firing on torn-down backend)", () => {
    // Regression for review-feedback finding #1: detachClient previously
    // dropped approvalRouterUnregisters without invoking them, leaving
    // stale entries in the still-alive WS client's inboundHandlers map.
    const tools = new GatewayToolBackend();
    const client = makeFakeClient();
    tools.attachClient(testDouble<GatewayWsClient>(client));
    tools.attachApprovalRouter(fakeDeps());
    expect(client.handlers.has("desktop.evaluateLocalPolicy")).toBe(true);
    expect(client.handlers.has("desktop.showApprovalCard")).toBe(true);

    tools.detachClient();

    expect(client.unregisters.get("desktop.evaluateLocalPolicy")).toHaveBeenCalledOnce();
    expect(client.unregisters.get("desktop.showApprovalCard")).toHaveBeenCalledOnce();
    expect(client.handlers.size).toBe(0);
  });

  it("attachClient(newClient) unregisters handlers on the prior client before re-registering", () => {
    // Same hazard as detachClient on the replacement path: if the prior
    // client is still alive, its inboundHandlers map must not retain
    // approval-router entries after we've moved to a new socket.
    const tools = new GatewayToolBackend();
    const oldClient = makeFakeClient();
    tools.attachClient(testDouble<GatewayWsClient>(oldClient));
    tools.attachApprovalRouter(fakeDeps());
    expect(oldClient.handlers.size).toBe(2);

    const newClient = makeFakeClient();
    tools.attachClient(testDouble<GatewayWsClient>(newClient));

    expect(oldClient.unregisters.get("desktop.evaluateLocalPolicy")).toHaveBeenCalledOnce();
    expect(oldClient.unregisters.get("desktop.showApprovalCard")).toHaveBeenCalledOnce();
    expect(oldClient.handlers.size).toBe(0);
    expect(newClient.handlers.size).toBe(2);
  });
});

describe("GatewayBackend reconnect loop", () => {
  beforeEach(() => {
    wsInstances.all = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function newBackend() {
    return new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/tmp/device-identity.json",
      gatewayToken: "test-token",
    });
  }

  /** Advance past the reconnect loop's backoff delay (exponential, starts at 1s). */
  async function advanceReconnectTick(ms = 1000) {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it("builds a second client after the current one disconnects", async () => {
    const backend = newBackend();
    await backend.login({ mode: "no-auth" });
    expect(wsInstances.all).toHaveLength(1);

    // Simulate the socket dropping.
    wsInstances.all[0].emitState("disconnected");
    await advanceReconnectTick();

    expect(wsInstances.all.length).toBeGreaterThanOrEqual(2);
  });

  it("signOut during a reconnect loop prevents the reconnect from establishing a new client", async () => {
    const backend = newBackend();
    await backend.login({ mode: "no-auth" });
    const clientsAfterSignIn = wsInstances.all.length;

    wsInstances.all[0].emitState("disconnected");

    // stopReconnect inside signOut awaits the loop promise; the loop is
    // blocked on setTimeout, so advance time concurrently to unblock it.
    const signOutPromise = backend.signOut();
    await advanceReconnectTick(2000);
    await signOutPromise;

    expect(wsInstances.all).toHaveLength(clientsAfterSignIn);
    expect(backend.isReady()).toBe(false);
  });

  it("login cancels the in-flight reconnect before rebuilding", async () => {
    const backend = newBackend();
    await backend.login({ mode: "no-auth" });

    wsInstances.all[0].emitState("disconnected");

    // login() awaits stopReconnect, which awaits the reconnect loop. Advance
    // timers concurrently so the sleep unblocks and the loop exits.
    const signInPromise = backend.login({ mode: "no-auth" });
    await advanceReconnectTick(2000);
    await signInPromise;

    // First login = client 0, second login = client 1. The reconnect loop
    // must NOT have produced a third client after stopReconnect returned.
    expect(wsInstances.all).toHaveLength(2);
    expect(wsInstances.all[0].close).toHaveBeenCalled();
  });
});

describe("GatewayBackend reconnect loop — hosted token reuse", () => {
  beforeEach(() => {
    wsInstances.all = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function advanceReconnectTick(ms = 1000) {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it("reuses the original hosted auth token on reconnect", async () => {
    const acquireWeaveToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("token-initial")
      .mockResolvedValueOnce("token-after-reconnect");
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/tmp/device-identity.json",
      gatewayToken: "test-token",
      hostedRuntime: testHostedRuntime(acquireWeaveToken),
    });
    await backend.login({ mode: "hosted" });
    expect(wsInstances.all).toHaveLength(1);
    expect(wsInstances.all[0].config.authToken).toBe("token-initial");
    expect(acquireWeaveToken).toHaveBeenCalledTimes(1);

    wsInstances.all[0].emitState("disconnected");
    await advanceReconnectTick();

    expect(wsInstances.all.length).toBeGreaterThanOrEqual(2);
    expect(wsInstances.all[1].config.authToken).toBe("token-initial");
    expect(acquireWeaveToken).toHaveBeenCalledTimes(1);
  });
});

describe("GatewaySessionBackend.patchLabel", () => {
  it("calls sessions.patch with the provided key + label", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient();
    mockClient.request = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue({ ok: true });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("sess-1", "k1");

    await backend.patchLabel("sess-1", "Nicer title");

    expect(mockClient.request).toHaveBeenCalledWith("sessions.patch", {
      key: "k1",
      label: "Nicer title",
    });
  });

  it("silently no-ops if sessionKey is missing (avoids races during reconcile)", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    await backend.patchLabel("unknown", "title");
    expect(mockClient.request).not.toHaveBeenCalled();
  });

  it("applies the latest rename after an in-flight create establishes the session key", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    const createResult = deferredPromise<{ ok: boolean; key: string; sessionId: string }>();
    mockClient.request = vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
    >((method) => {
      if (method === "sessions.create") return createResult.promise;
      return Promise.resolve({ ok: true });
    });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));

    const creating = backend.create({
      sessionId: "sess-pending-rename",
      systemMessage: "",
      model: "claude-opus-4-7",
    });
    await vi.waitFor(() =>
      expect(mockClient.request).toHaveBeenCalledWith("sessions.create", {
        label: "sess-pending-rename",
        model: "claude-opus-4-7",
      }),
    );

    const renaming = backend.notifyRenamed("sess-pending-rename", "Renamed immediately");
    expect(mockClient.request).not.toHaveBeenCalledWith("sessions.patch", expect.anything());

    createResult.resolve({
      ok: true,
      key: "agent:main:pending-rename",
      sessionId: "cloud-pending-rename",
    });
    await Promise.all([creating, renaming]);

    expect(mockClient.request).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:pending-rename",
      label: "Renamed immediately",
    });
  });

  it("serializes concurrent renames so an older patch cannot overwrite the latest label", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient();
    const firstPatch = deferredPromise<Record<string, unknown>>();
    const secondPatch = deferredPromise<Record<string, unknown>>();
    let patchCount = 0;
    let remoteLabel = "";
    mockClient.request = vi.fn<
      (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
    >((method, params) => {
      if (method !== "sessions.patch") return Promise.resolve({ ok: true });
      patchCount += 1;
      const gate = patchCount === 1 ? firstPatch : secondPatch;
      return gate.promise.then((result) => {
        remoteLabel = typeof params.label === "string" ? params.label : "";
        return result;
      });
    });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("sess-rename-race", "k-race");

    const older = backend.patchLabel("sess-rename-race", "Older");
    await vi.waitFor(() => expect(patchCount).toBe(1));
    const newer = backend.patchLabel("sess-rename-race", "Newest");
    await Promise.resolve();
    expect(patchCount).toBe(1);

    firstPatch.resolve({ ok: true });
    await vi.waitFor(() => expect(patchCount).toBe(2));
    secondPatch.resolve({ ok: true });
    await Promise.all([older, newer]);

    expect(remoteLabel).toBe("Newest");
    expect(mockClient.request).toHaveBeenNthCalledWith(1, "sessions.patch", {
      key: "k-race",
      label: "Older",
    });
    expect(mockClient.request).toHaveBeenNthCalledWith(2, "sessions.patch", {
      key: "k-race",
      label: "Newest",
    });
  });
});

describe("GatewaySessionBackend — symmetric lifecycle hooks (Phase 1 bridging)", () => {
  it("subscribeToRemoteEvents wraps the existing subscribe path and returns an unsub function", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    // sessions.list returns empty; sessions.subscribe returns an unsubscribe
    mockClient.request = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
      sessions: [],
    });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));

    const received: import("../types").RemoteSessionEvent[] = [];
    const unsub = await backend.subscribeToRemoteEvents((evt) => received.push(evt));

    // Return value must be a function (unsubscribe).
    expect(typeof unsub).toBe("function");
    // With an empty sessions list the snapshot emits an index-snapshot with empty sessions.
    expect(received).toHaveLength(1);
    expect(expectRemoteSessionEvent(received[0], "index-snapshot").sessions).toEqual([]);

    // Calling unsub must not throw.
    expect(() => unsub()).not.toThrow();
  });

  it("subscribeToRemoteEvents returns an unsub without error when not connected", async () => {
    // client is null — must return a no-op unsubscribe, not throw.
    const backend = new GatewaySessionBackend();
    const unsub = await backend.subscribeToRemoteEvents(() => {});
    expect(typeof unsub).toBe("function");
    expect(() => unsub()).not.toThrow();
  });

  it("subscribeToRemoteEvents emits index-snapshot with parsed sessions", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    mockClient.request = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
      sessions: [
        { key: "k1", sessionId: "cloud-1", label: "My Chat", updatedAt: 1000 },
        { key: "k2", sessionId: "cloud-2", derivedTitle: "Second", updatedAt: 2000 },
      ],
    });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));

    const received: import("../types").RemoteSessionEvent[] = [];
    await backend.subscribeToRemoteEvents((evt) => received.push(evt));

    expect(received).toHaveLength(1);
    const snap = expectRemoteSessionEvent(received[0], "index-snapshot");
    expect(snap.sessions).toHaveLength(2);
    expect(snap.sessions[0].backendId).toBe("cloud-1");
    expect(snap.sessions[0].name).toBe("My Chat");
    expect(snap.sessions[1].backendId).toBe("cloud-2");
  });

  it("applyConfigChange warns and does NOT call recreate (no cloud session leak)", async () => {
    const backend = new GatewaySessionBackend();
    const mockClient = makeMockClient();
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));

    const recreate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await backend.applyConfigChange("sess-1", recreate);
      // recreate must NOT be called — calling it would destroy the cloud session.
      expect(recreate).not.toHaveBeenCalled();
      // A warn should be emitted so the developer knows this is a known no-op.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("applyConfigChange"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("notifyRenamed fires sessions.patch { label } RPC", async () => {
    const backend = new GatewaySessionBackend();
    const access = new GatewayBackendTestAccess(backend);
    const mockClient = makeMockClient();
    mockClient.request = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue({ ok: true });
    backend.attachClient(testDouble<GatewayWsClient>(mockClient));
    access.setSessionKey("sess-1", "k1");

    await backend.notifyRenamed("sess-1", "New Name");

    expect(mockClient.request).toHaveBeenCalledWith("sessions.patch", {
      key: "k1",
      label: "New Name",
    });
  });

  it("notifyRenamed is a no-op when client is not connected", async () => {
    const backend = new GatewaySessionBackend();
    // No attachClient — client is null.
    // Must not throw.
    await expect(backend.notifyRenamed("sess-1", "New Name")).resolves.toBeUndefined();
  });
});

describe("GatewayBackend orchestrator wiring", () => {
  it("init() attaches orchestrator to the client", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/mock/identity.json",
      gatewayToken: "test-token",
    });
    // Get a reference to track attachClient calls. Since the test environment
    // mocks GatewayWsClient, we can spy on the orchestrator's attachClient.
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion -- accessing private field for testing
    const orchestrator = (backend as unknown as { _orchestrator: GatewayAutomationOrchestrator })
      ._orchestrator;
    const orchestratorSpy = vi.spyOn(orchestrator, "attachClient");
    await backend.init();
    expect(orchestratorSpy).toHaveBeenCalledOnce();
  });

  it("init() calls reconcile() on the orchestrator with error handling", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/mock/identity.json",
      gatewayToken: "test-token",
    });
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion -- accessing private field for testing
    const orchestrator = (backend as unknown as { _orchestrator: GatewayAutomationOrchestrator })
      ._orchestrator;
    const reconcileSpy = vi.spyOn(orchestrator, "reconcile");
    // Ensure reconcile returns a resolved promise so init completes.
    reconcileSpy.mockResolvedValue(undefined);

    await backend.init();

    expect(reconcileSpy).toHaveBeenCalledOnce();
  });

  it("destroy() detaches orchestrator from the client", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/mock/identity.json",
      gatewayToken: "test-token",
    });
    await backend.init();
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion -- accessing private field for testing
    const orchestrator = (backend as unknown as { _orchestrator: GatewayAutomationOrchestrator })
      ._orchestrator;
    const orchestratorSpy = vi.spyOn(orchestrator, "detachClient");
    await backend.destroy();
    expect(orchestratorSpy).toHaveBeenCalledOnce();
  });

  it("signOut() detaches orchestrator from the client", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/mock/identity.json",
      gatewayToken: "test-token",
    });
    await backend.init();
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion -- accessing private field for testing
    const orchestrator = (backend as unknown as { _orchestrator: GatewayAutomationOrchestrator })
      ._orchestrator;
    const orchestratorSpy = vi.spyOn(orchestrator, "detachClient");
    await backend.signOut();
    expect(orchestratorSpy).toHaveBeenCalledOnce();
  });

  it("reconcile failure does not block init", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/mock/identity.json",
      gatewayToken: "test-token",
    });
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion -- accessing private field for testing
    const orchestrator = (backend as unknown as { _orchestrator: GatewayAutomationOrchestrator })
      ._orchestrator;
    const reconcileSpy = vi.spyOn(orchestrator, "reconcile");
    const testError = new Error("reconcile test failure");
    reconcileSpy.mockRejectedValue(testError);

    // init should complete successfully despite reconcile failure
    await expect(backend.init()).resolves.toBeUndefined();
    expect(reconcileSpy).toHaveBeenCalledOnce();
  });
});

describe("GatewayBackend desktop-capabilities wiring", () => {
  beforeEach(() => {
    // Each test asserts on the WS client for that test alone. Clear the
    // shared instance log so `wsInstances.all[0]` is unambiguous.
    wsInstances.all = [];
  });

  /** Minimal `IPermissionPolicy`-shaped stub. Only `evaluate` matters for
   *  these wiring tests — `recordInteractiveOutcome` and `logInfraFailure`
   *  are present so the stub satisfies the port without `as`-casting. */
  const fakePolicy = (): AttachDesktopCapabilitiesDeps["policy"] => ({
    evaluate: vi.fn<() => "approve" | "deny" | "prompt">(() => "approve"),
    recordInteractiveOutcome: vi.fn<() => boolean>(() => true),
    logInfraFailure: vi.fn<() => void>(),
  });

  /** The 3 desktop.* RPCs the bridge attaches (post-attachApprovalRouter
   *  refactor: showApprovalCard + evaluateLocalPolicy live on the approval
   *  router, not on this bridge). */
  const BRIDGE_DESKTOP_METHODS = ["desktop.executeLocalTool", "desktop.showNotification"];
  const expectBridgeAttached = (client: MockWsClient): void => {
    for (const m of BRIDGE_DESKTOP_METHODS) expect(client.inboundHandlers.has(m)).toBe(true);
  };
  const expectBridgeDetached = (client: MockWsClient): void => {
    for (const m of BRIDGE_DESKTOP_METHODS) expect(client.inboundHandlers.has(m)).toBe(false);
  };

  const policyDeps = (): AttachDesktopCapabilitiesDeps => ({
    policy: fakePolicy(),
    toolInvocationManager: {
      claimBackgroundToolDispatch: async (request) => ({
        kind: "claimed",
        claim: {
          claimId: `${request.ownerSessionId}:${request.toolCallId}:claim`,
          ownerSessionId: request.ownerSessionId,
          toolCallId: request.toolCallId,
          claimedAtMs: request.requestedAtMs,
          cancellationToken: {
            tokenId: `${request.ownerSessionId}:${request.toolCallId}:token`,
            ownerSessionId: request.ownerSessionId,
            claimId: `${request.ownerSessionId}:${request.toolCallId}:claim`,
            issuedAtMs: request.requestedAtMs,
          },
        },
      }),
      beginBackgroundToolInvocation: async (args) => {
        const invocation = {
          handle: `${args.sessionId}:${args.toolCallId}`,
          sessionId: args.sessionId,
          toolCallId: args.toolCallId,
          toolName: args.toolName,
          startedAt: "2026-06-08T14:00:00.000Z",
          elapsedMs: 0,
          status: "running" as const,
          backgrounded: false,
          resultAvailable: false,
          longRunning: false,
          cancellable: true,
          cancellationScope: "tool" as const,
        };
        return { handle: invocation.handle, claim: args.claim, invocation };
      },
      attachBackgroundToolProcess: async () => null,
      detachBackgroundToolInvocation: async () => null,
      completeBackgroundToolInvocation: async () => null,
      requestBackgroundToolCancellation: async (request) => ({
        success: true,
        handle: request.handle,
        sessionId: request.token.ownerSessionId,
        status: "cancelling",
        cancellationScope: "tool",
      }),
    },
  });

  it("init() does NOT attach desktop.* RPC handlers when deps are unset", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/mock/identity.json",
      gatewayToken: "test-token",
    });
    await backend.init();
    expectBridgeDetached(wsInstances.all[0]);
  });

  it("init() registers all desktop.* RPC handlers when deps are set", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/mock/identity.json",
      gatewayToken: "test-token",
    });
    backend.tools.attachDesktopCapabilities(policyDeps());
    await backend.init();
    expectBridgeAttached(wsInstances.all[0]);
  });

  it("destroy() unregisters all desktop.* RPC handlers", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/mock/identity.json",
      gatewayToken: "test-token",
    });
    backend.tools.attachDesktopCapabilities(policyDeps());
    await backend.init();
    const client = wsInstances.all[0];
    expectBridgeAttached(client);

    await backend.destroy();
    expectBridgeDetached(client);
  });

  it("forceKill() unregisters all desktop.* RPC handlers", async () => {
    // forceKill shares the synchronous teardown path with destroy/signOut but
    // doesn't wait on stopReconnect / cloud RPCs. Mirror the destroy/signOut
    // tests so a regression in the forceKill detach path fails here.
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/mock/identity.json",
      gatewayToken: "test-token",
    });
    backend.tools.attachDesktopCapabilities(policyDeps());
    await backend.init();
    const client = wsInstances.all[0];
    expectBridgeAttached(client);

    await backend.forceKill();
    expectBridgeDetached(client);
  });

  it("signOut() unregisters all desktop.* RPC handlers", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/mock/identity.json",
      gatewayToken: "test-token",
    });
    backend.tools.attachDesktopCapabilities(policyDeps());
    await backend.init();
    const client = wsInstances.all[0];
    expectBridgeAttached(client);

    await backend.signOut();
    expectBridgeDetached(client);
  });

  it("re-init re-registers handlers on the fresh WS client (reconnect path)", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/mock/identity.json",
      gatewayToken: "test-token",
    });
    backend.tools.attachDesktopCapabilities(policyDeps());
    await backend.init();
    const firstClient = wsInstances.all[0];
    expectBridgeAttached(firstClient);

    // Force a re-init via destroy + init (simulates the reconnect path).
    await backend.destroy();
    await backend.init();
    const secondClient = wsInstances.all[1];
    expect(secondClient).not.toBe(firstClient);
    expectBridgeAttached(secondClient);
    // First client's registry was unregistered on destroy; new handlers
    // landed on the fresh client only.
    expectBridgeDetached(firstClient);
  });

  it("attachDesktopCapabilities after init() attaches immediately without waiting for reconnect", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/mock/identity.json",
      gatewayToken: "test-token",
    });
    await backend.init();
    const client = wsInstances.all[0];
    expectBridgeDetached(client);

    backend.tools.attachDesktopCapabilities(policyDeps());

    expectBridgeAttached(client);
  });
});

describe("GatewayBackend.capabilities — condition trigger", () => {
  it("reports automations.conditionTrigger: true", () => {
    // Capability flags are static — no need to connect or init the backend.
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/tmp/nonexistent",
      gatewayToken: "test-token",
    });
    expect(backend.capabilities().automations.conditionTrigger).toBe(true);
  });
});

describe("GatewayBackend — sessions.changed → conditionSupervisor wiring", () => {
  beforeEach(() => {
    wsInstances.all = [];
  });

  it("routes sessions.changed { reason: 'create', parentSessionKey: …:cron:<id>:run:… } to handleSpawnFromCron", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/tmp/device-identity.json",
      gatewayToken: "test-token",
    });
    const handleSpawnFromCron = vi.fn<(cronId: string) => Promise<void>>().mockResolvedValue();
    const stub = {
      registerWatcher: vi.fn<() => void>(),
      unregisterWatcher: vi.fn<(cronId: string) => void>(),
      handleSpawnFromCron,
    };
    backend.attachConditionSupervisor(stub);

    await backend.login({ mode: "no-auth" });
    const ws = wsInstances.all[0];

    expect(ws.onEvent).toHaveBeenCalled();
    ws.emitEvent("sessions.changed", {
      reason: "create",
      session: { parentSessionKey: "agent:foo:cron:cron-1:run:abc" },
    });

    expect(handleSpawnFromCron).toHaveBeenCalledWith("cron-1");
  });

  it("ignores sessions.changed without a cron-shaped parentSessionKey", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/tmp/device-identity.json",
      gatewayToken: "test-token",
    });
    const handleSpawnFromCron = vi.fn<(cronId: string) => Promise<void>>().mockResolvedValue();
    const stub = {
      registerWatcher: vi.fn<() => void>(),
      unregisterWatcher: vi.fn<(cronId: string) => void>(),
      handleSpawnFromCron,
    };
    backend.attachConditionSupervisor(stub);

    await backend.login({ mode: "no-auth" });
    const ws = wsInstances.all[0];

    ws.emitEvent("sessions.changed", {
      reason: "create",
      session: { parentSessionKey: "agent:foo:user-chat-1" },
    });
    ws.emitEvent("sessions.changed", {
      reason: "patch",
      session: { parentSessionKey: "agent:foo:cron:cron-2:run:xyz" },
    });

    expect(handleSpawnFromCron).not.toHaveBeenCalled();
  });
});

describe("GatewayBackend.setOnAutomationsChangedBroadcaster", () => {
  beforeEach(() => {
    wsInstances.all = [];
  });

  it("invokes the registered broadcaster when an automation change fires; null clears it", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/tmp/device-identity.json",
      gatewayToken: "test-token",
    });
    const broadcaster = vi.fn<() => void>();
    backend.setOnAutomationsChangedBroadcaster(broadcaster);

    await backend.login({ mode: "no-auth" });
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- GatewayAutomationBackend exposes recordKnownConditionAutomation/handleCronEvent beyond IAutomationBackend; narrow via Pick instead of `as any`
    const automationBackend = backend.automation as unknown as Pick<
      GatewayAutomationBackend,
      "onAutomationsChanged" | "recordKnownConditionAutomation" | "handleCronEvent"
    >;
    automationBackend.recordKnownConditionAutomation({
      id: "cron-x",
      name: "n",
      triggerType: "condition",
      enabled: true,
      condition: "c",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });

    automationBackend.handleCronEvent({ action: "removed", jobId: "cron-x" });
    expect(broadcaster).toHaveBeenCalledTimes(1);

    backend.setOnAutomationsChangedBroadcaster(null);
    automationBackend.recordKnownConditionAutomation({
      id: "cron-y",
      name: "n",
      triggerType: "condition",
      enabled: true,
      condition: "c",
      conditionCheckInterval: 15,
      steps: [{ id: "s1", label: "L", prompt: "p" }],
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    });
    automationBackend.handleCronEvent({ action: "removed", jobId: "cron-y" });
    expect(broadcaster).toHaveBeenCalledTimes(1);
  });
});

describe("GatewayBackend.renameNode", () => {
  beforeEach(() => {
    wsInstances.all = [];
  });

  it("sends node.rename over the operator socket with nodeId and displayName", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/tmp/device-identity.json",
      gatewayToken: "test-token",
    });
    await backend.login({ mode: "no-auth" });
    const ws = wsInstances.all[0];

    await backend.renameNode("node-id-1", "My Mac");

    expect(ws.request).toHaveBeenCalledWith("node.rename", {
      nodeId: "node-id-1",
      displayName: "My Mac",
    });
  });

  it("throws when the operator socket is not connected", async () => {
    const backend = new GatewayBackend({
      gatewayUrl: "ws://localhost:18789",
      hostedGatewayUrl: "ws://localhost:18789",
      deviceIdentityPath: "/tmp/device-identity.json",
      gatewayToken: "test-token",
    });

    await expect(backend.renameNode("node-id-1", "My Mac")).rejects.toThrow(
      "operator socket not connected",
    );
  });
});
