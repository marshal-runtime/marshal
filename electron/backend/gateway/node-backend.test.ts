import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/mock", getPath: () => "/mock" },
}));

type StateChangeListener = (state: "connecting" | "connected" | "disconnected") => void;
type EventListener = (eventName: string, payload: Record<string, unknown>) => void;

interface MockWsClient {
  connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  close: ReturnType<typeof vi.fn<() => void>>;
  isConnected: ReturnType<typeof vi.fn<() => boolean>>;
  request: ReturnType<
    typeof vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>
  >;
  onEvent: ReturnType<typeof vi.fn<(l: EventListener) => () => void>>;
  emitEvent: (eventName: string, payload: Record<string, unknown>) => void;
  config: Record<string, unknown>;
  emitState: (state: "connecting" | "connected" | "disconnected") => void;
}

const wsInstances = vi.hoisted<{ all: MockWsClient[] }>(() => ({ all: [] }));
const connectOverride = vi.hoisted<{ fn: ((attempt: number) => Promise<void>) | null }>(() => ({
  fn: null,
}));

vi.mock("./ws-client", () => {
  class MockGatewayWsClient {
    connect = vi.fn<() => Promise<void>>().mockImplementation(async () => {
      if (connectOverride.fn) {
        await connectOverride.fn(wsInstances.all.length);
      }
    });
    close = vi.fn<() => void>();
    isConnected = vi.fn<() => boolean>().mockReturnValue(true);
    private stateListeners = new Set<StateChangeListener>();
    onStateChange = vi.fn<(l: StateChangeListener) => () => void>((l) => {
      this.stateListeners.add(l);
      return () => this.stateListeners.delete(l);
    });
    emitState = (state: "connecting" | "connected" | "disconnected"): void => {
      for (const l of this.stateListeners) l(state);
    };
    private eventListeners = new Set<EventListener>();
    onEvent = vi.fn<(l: EventListener) => () => void>((l) => {
      this.eventListeners.add(l);
      return () => this.eventListeners.delete(l);
    });
    emitEvent = (eventName: string, payload: Record<string, unknown>): void => {
      for (const l of this.eventListeners) l(eventName, payload);
    };
    request = vi
      .fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue({ ok: true });
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      wsInstances.all.push(this as unknown as MockWsClient); // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test mock conforms
    }
  }
  class MockPairingRequiredError extends Error {
    readonly name = "GatewayPairingRequiredError";
    constructor(readonly requestId: string) {
      super(`pairing required (requestId=${requestId})`);
    }
  }
  return {
    GatewayWsClient: MockGatewayWsClient,
    GatewayPairingRequiredError: MockPairingRequiredError,
    nodeRoleConfig: (commands: ReadonlyArray<string>, displayName?: string) => ({
      role: "node",
      scopes: [],
      clientMode: "node",
      commands,
      ...(displayName !== undefined && displayName.length > 0 ? { displayName } : {}),
    }),
  };
});

vi.mock("./device-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-identity")>();
  return {
    ...actual,
    readDeviceIdentity: vi.fn<() => unknown>().mockReturnValue({
      adapterId: "test-adapter",
      privateKeyPem: "stub-pem",
      publicKeyPem: "stub-pem",
      keyId: "test-key",
    }),
  };
});

const config = {
  gatewayUrl: "ws://local/marshal-gateway",
  hostedGatewayUrl: "wss://aether.local/marshal-gateway",
  deviceIdentityPath: "/mock/identity.json",
  gatewayToken: "stub-gateway-token",
} as const;

const noAuthTokenProvider = async (): Promise<string | undefined> => undefined;

beforeEach(() => {
  wsInstances.all.length = 0;
  connectOverride.fn = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GatewayNodeBackend — basic lifecycle", () => {
  it("start() opens a WS client with role=node and the supplied commands", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);

    await backend.start({
      cred: { mode: "no-auth" },
      acquireAuthToken: noAuthTokenProvider,
      commands: ["mcp.fs.read_file", "mcp.fs.list_directory"],
    });

    expect(wsInstances.all).toHaveLength(1);
    const cfg = wsInstances.all[0].config;
    expect(cfg.url).toBe(config.gatewayUrl);
    expect(cfg.roleConfig).toMatchObject({
      clientMode: "node",
      commands: ["mcp.fs.read_file", "mcp.fs.list_directory"],
    });
    expect(backend.isConnected()).toBe(true);
  });

  it("start() picks the AAD URL when cred.mode === 'hosted'", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);
    await backend.start({
      cred: { mode: "hosted" },
      acquireAuthToken: async () => "weave-token-xyz",
      commands: [],
    });
    expect(wsInstances.all[0].config.url).toBe(config.hostedGatewayUrl);
    expect(wsInstances.all[0].config.authToken).toBe("weave-token-xyz");
  });

  it("acquireAuthToken is called once per (re)connect attempt", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);
    let calls = 0;
    await backend.start({
      cred: { mode: "hosted" },
      acquireAuthToken: async () => {
        calls++;
        return `token-${calls}`;
      },
      commands: [],
    });
    expect(calls).toBe(1);
    expect(wsInstances.all[0].config.authToken).toBe("token-1");
    await backend.start({
      cred: { mode: "hosted" },
      acquireAuthToken: async () => {
        calls++;
        return `token-${calls}`;
      },
      commands: [],
    });
    expect(calls).toBe(2);
    expect(wsInstances.all[1].config.authToken).toBe("token-2");
  });

  it("stop() closes the client and clears the activity log", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);
    await backend.start({
      cred: { mode: "no-auth" },
      acquireAuthToken: noAuthTokenProvider,
      commands: [],
    });
    backend.getActivityLogForBridge().push({
      direction: "inbound",
      command: "mcp.fs.read_file",
      invocationId: "inv-1",
      status: "received",
    });
    expect(backend.getActivityLog().getAll()).toHaveLength(1);

    await backend.stop();
    expect(wsInstances.all[0].close).toHaveBeenCalled();
    expect(backend.isConnected()).toBe(false);
    expect(backend.getActivityLog().getAll()).toHaveLength(0);
  });

  it("dispatches inbound node.invoke.request events through the bridge handler and replies via node.invoke.result", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);
    await backend.start({
      cred: { mode: "no-auth" },
      acquireAuthToken: noAuthTokenProvider,
      commands: [],
    });

    const handler = vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(async () => ({
      ok: true,
      tools: [],
      guidance: "ok",
    }));
    backend.setInvokeHandler(handler);

    wsInstances.all[0].emitEvent("node.invoke.request", {
      id: "inv-42",
      nodeId: "test-node-id",
      command: "mcp.help",
      paramsJSON: "{}",
      idempotencyKey: "key-42",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handler).toHaveBeenCalledWith({
      command: "mcp.help",
      invocationId: "inv-42",
      args: {},
    });

    const requestCalls = wsInstances.all[0].request.mock.calls;
    const resultCall = requestCalls.find((c) => c[0] === "node.invoke.result");
    expect(resultCall).toBeDefined();
    expect(resultCall?.[1]).toMatchObject({
      id: "inv-42",
      nodeId: "test-node-id",
      ok: true,
      payload: { ok: true, tools: [], guidance: "ok" },
    });
  });

  it("ignores non-invoke events (e.g. health, tick) and never calls the bridge", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);
    await backend.start({
      cred: { mode: "no-auth" },
      acquireAuthToken: noAuthTokenProvider,
      commands: [],
    });
    const handler = vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(async () => ({
      ok: true,
    }));
    backend.setInvokeHandler(handler);

    wsInstances.all[0].emitEvent("health", { ok: true });
    wsInstances.all[0].emitEvent("tick", { ts: 123 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handler).not.toHaveBeenCalled();
  });

  it("translates a bridge failure into a structured node.invoke.result error envelope", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);
    await backend.start({
      cred: { mode: "no-auth" },
      acquireAuthToken: noAuthTokenProvider,
      commands: [],
    });
    backend.setInvokeHandler(async () => ({
      ok: false,
      error: "Server X is not opted in",
      code: "not-allowed",
    }));

    wsInstances.all[0].emitEvent("node.invoke.request", {
      id: "inv-fail",
      nodeId: "test-node-id",
      command: "mcp.invoke",
      paramsJSON: JSON.stringify({ server: "X", tool: "Y", input: {} }),
      idempotencyKey: "k",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const resultCall = wsInstances.all[0].request.mock.calls.find(
      (c) => c[0] === "node.invoke.result",
    );
    expect(resultCall?.[1]).toMatchObject({
      id: "inv-fail",
      nodeId: "test-node-id",
      ok: false,
      error: { code: "not-allowed", message: "Server X is not opted in" },
    });
  });

  it("re-attaches the invoke listener on the new client after a stop/start cycle", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);
    await backend.start({
      cred: { mode: "no-auth" },
      acquireAuthToken: noAuthTokenProvider,
      commands: [],
    });
    const handler = vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(async () => ({
      ok: true,
    }));
    backend.setInvokeHandler(handler);

    await backend.stop();
    await backend.start({
      cred: { mode: "no-auth" },
      acquireAuthToken: noAuthTokenProvider,
      commands: [],
    });

    const latest = wsInstances.all[wsInstances.all.length - 1];
    latest.emitEvent("node.invoke.request", {
      id: "inv-after-cycle",
      nodeId: "test-node-id",
      command: "mcp.help",
      paramsJSON: "{}",
      idempotencyKey: "k",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handler).toHaveBeenCalledWith({
      command: "mcp.help",
      invocationId: "inv-after-cycle",
      args: {},
    });
    const resultCall = latest.request.mock.calls.find((c) => c[0] === "node.invoke.result");
    expect(resultCall).toBeDefined();
    expect(resultCall?.[1]).toMatchObject({ id: "inv-after-cycle", ok: true });
  });

  it("onConnected fires after a successful start()", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);
    const cb = vi.fn<() => void>();
    backend.onConnected(cb);
    await backend.start({
      cred: { mode: "no-auth" },
      acquireAuthToken: noAuthTokenProvider,
      commands: [],
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("cancelPairing() before any pairing wait is a no-op (doesn't throw)", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);
    expect(() => backend.cancelPairing()).not.toThrow();
  });

  it("passes nodeName as displayName through nodeRoleConfig to the WS client config", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);
    await backend.start({
      cred: { mode: "hosted", nodeName: "Alice Mac" },
      acquireAuthToken: noAuthTokenProvider,
      commands: ["mcp.help"],
    });
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test seam: config.roleConfig is the mock's plain object, shape known
    const roleConfig = wsInstances.all[0].config.roleConfig as Record<string, unknown>;
    expect(roleConfig).toBeDefined();
    expect(roleConfig["displayName"]).toBe("Alice Mac");
  });
});

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    // oxlint-disable-next-line no-await-in-loop -- intentional sequential drain
    await Promise.resolve();
  }
}

function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, err }),
  );
}

describe("GatewayNodeBackend — pairing wait loop", () => {
  it("retries connect until the gateway approves, then returns from start()", async () => {
    vi.useFakeTimers();
    try {
      const { GatewayNodeBackend } = await import("./node-backend");
      const { GatewayPairingRequiredError } = await import("./ws-client");
      let attempts = 0;
      connectOverride.fn = async () => {
        attempts++;
        if (attempts < 3) {
          throw new GatewayPairingRequiredError("req-1");
        }
      };
      const backend = new GatewayNodeBackend(config);
      const startPromise = settle(
        backend.start({
          cred: { mode: "no-auth" },
          acquireAuthToken: noAuthTokenProvider,
          commands: [],
        }),
      );
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
      const r = await startPromise;
      expect(r.ok).toBe(true);
      expect(attempts).toBe(3);
      expect(backend.isConnected()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancelPairing() during the wait loop surfaces PairingCancelledError", async () => {
    vi.useFakeTimers();
    try {
      const { GatewayNodeBackend } = await import("./node-backend");
      const { GatewayPairingRequiredError } = await import("./ws-client");
      const { PairingCancelledError } = await import("./auth/pairing-cancelled-error");
      connectOverride.fn = async () => {
        throw new GatewayPairingRequiredError("req-1");
      };
      const backend = new GatewayNodeBackend(config);
      const startPromise = settle(
        backend.start({
          cred: { mode: "no-auth" },
          acquireAuthToken: noAuthTokenProvider,
          commands: [],
        }),
      );
      await flushMicrotasks();
      backend.cancelPairing();
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
      const r = await startPromise;
      expect(r.ok).toBe(false);
      expect(r.ok ? null : r.err).toBeInstanceOf(PairingCancelledError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GatewayNodeBackend — reconnect loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("after disconnect emit, schedules and creates a new WS client", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);
    await backend.start({
      cred: { mode: "no-auth" },
      acquireAuthToken: noAuthTokenProvider,
      commands: [],
    });
    expect(wsInstances.all).toHaveLength(1);

    wsInstances.all[0].emitState("disconnected");

    await vi.advanceTimersByTimeAsync(2_000);

    expect(wsInstances.all.length).toBeGreaterThanOrEqual(2);
  });

  it("reconnecting transitions fire setReconnectingChangeCallback true→false", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);
    const transitions: boolean[] = [];
    backend.setReconnectingChangeCallback((v) => transitions.push(v));
    await backend.start({
      cred: { mode: "no-auth" },
      acquireAuthToken: noAuthTokenProvider,
      commands: [],
    });

    wsInstances.all[0].emitState("disconnected");
    await vi.advanceTimersByTimeAsync(2_000);
    wsInstances.all[1]?.emitState("connected");
    await vi.advanceTimersByTimeAsync(50);

    expect(transitions[0]).toBe(true);
    expect(transitions[transitions.length - 1]).toBe(false);
  });

  it("stop() during the reconnect loop does not spawn a third client", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);
    await backend.start({
      cred: { mode: "no-auth" },
      acquireAuthToken: noAuthTokenProvider,
      commands: [],
    });
    wsInstances.all[0].emitState("disconnected");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(wsInstances.all.length).toBe(2);

    await backend.stop();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(wsInstances.all.length).toBe(2);
  });

  it("invoke handler dispatches end-to-end on the new WS client after reconnect", async () => {
    const { GatewayNodeBackend } = await import("./node-backend");
    const backend = new GatewayNodeBackend(config);
    const handler = vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(async () => ({
      ok: true,
      tools: [],
      guidance: "ok",
    }));
    backend.setInvokeHandler(handler);
    await backend.start({
      cred: { mode: "no-auth" },
      acquireAuthToken: noAuthTokenProvider,
      commands: [],
    });

    wsInstances.all[0].emitState("disconnected");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(wsInstances.all.length).toBeGreaterThanOrEqual(2);

    wsInstances.all[1].emitEvent("node.invoke.request", {
      id: "inv-reconnect",
      nodeId: "test-node-id",
      command: "mcp.help",
      paramsJSON: "{}",
      idempotencyKey: "key-reconnect",
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      command: "mcp.help",
      invocationId: "inv-reconnect",
    });
    const replyCalls = wsInstances.all[1].request.mock.calls.filter(
      (c) => c[0] === "node.invoke.result",
    );
    expect(replyCalls.length).toBe(1);
    expect(replyCalls[0][1]).toMatchObject({ id: "inv-reconnect", ok: true });
  });
});
