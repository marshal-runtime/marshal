// In-process IGatewayWsClient impl used only under `MARSHAL_E2E=1 + MARSHAL_GATEWAY_E2E=1`.
// Dispatches RPCs through a GatewayTestScenario and emits scripted server-push
// frames; production code never imports this file.

import { randomUUID } from "crypto";

import { createLogger } from "../../../common/marshal-logger";
import type {
  GatewayTestScenario,
  GatewayTestRpcHandler,
  GatewayTestRpcMethod,
  GatewayTestFrame,
} from "./testing/scenario-script";
import { DEFAULT_GATEWAY_TEST_CHAT_SCENARIO } from "./testing/scenario-script";
import type { ConnectionState, IGatewayWsClient } from "./ws-client";
import { LEGACY_GATEWAY_EXECUTION_CAPABILITIES } from "./ws-client";

const log = createLogger("MockGatewayWsClient");

type EventListener = (eventName: string, payload: Record<string, unknown>) => void;
type StateChangeListener = (state: ConnectionState) => void;
type InboundHandler = (params: Record<string, unknown>) => Promise<unknown>;

function defaultHandlers(): Record<GatewayTestRpcMethod, GatewayTestRpcHandler> {
  return {
    "sessions.list": async () => ({ sessions: [] }),
    "sessions.subscribe": async () => ({ ok: true }),
    "sessions.create": async (params) => ({
      key: typeof params.key === "string" ? params.key : `mock-key-${randomUUID()}`,
      sessionId: `mock-session-${randomUUID()}`,
    }),
    "sessions.patch": async () => ({ ok: true }),
    "sessions.delete": async (params) => ({
      ok: true,
      key: typeof params.key === "string" ? params.key : "",
      deleted: true,
    }),
    "chat.send": async () => ({ runId: `mock-run-${randomUUID()}` }),
    "chat.abort": async () => ({ ok: true, aborted: true, runIds: [] }),
    "chat.history": async () => ({ messages: [] }),
    "models.list": async () => ({
      models: [{ id: "mock-model", name: "Mock Model" }],
    }),
  };
}

function substituteRunId(payload: Record<string, unknown>, runId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === "string") {
      out[k] = v === "$runId" ? runId : v;
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = substituteRunId(v as Record<string, unknown>, runId); // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof+null+!Array.isArray checks above
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class MockGatewayWsClient implements IGatewayWsClient {
  private connected = false;
  private readonly listeners = new Set<EventListener>();
  private readonly stateListeners = new Set<StateChangeListener>();
  private readonly inboundHandlers = new Map<string, InboundHandler>();
  private readonly scenario: GatewayTestScenario;
  private readonly handlers: Partial<Record<GatewayTestRpcMethod, GatewayTestRpcHandler>>;
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(scenario: GatewayTestScenario = DEFAULT_GATEWAY_TEST_CHAT_SCENARIO) {
    this.scenario = scenario;
    this.handlers = { ...defaultHandlers(), ...(scenario.rpcs ?? {}) };
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.emitState("connected");
  }

  close(): void {
    if (!this.connected) return;
    this.connected = false;
    // Cancel any scheduled chat frames so Playwright teardown doesn't keep
    // the Node event loop alive waiting for them to fire.
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers.clear();
    this.emitState("disconnected");
  }

  isConnected(): boolean {
    return this.connected;
  }

  getExecutionCapabilities() {
    return LEGACY_GATEWAY_EXECUTION_CAPABILITIES;
  }

  onStateChange(listener: StateChangeListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerInboundHandler(method: string, handler: InboundHandler): () => void {
    if (this.inboundHandlers.has(method)) {
      throw new Error(`[mock-gateway-ws] inbound handler for "${method}" already registered`);
    }
    this.inboundHandlers.set(method, handler);
    return () => this.inboundHandlers.delete(method);
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      throw new Error("[mock-gateway-ws] Not connected");
    }
    const handler = this.handlers[method as GatewayTestRpcMethod]; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- string→union widening for typed map lookup; the if-guard below is the runtime safety net
    if (!handler) {
      log.info(`[mock] not-supported: ${method}`);
      throw new Error(`[mock-gateway-ws] not-supported: ${method}`);
    }
    const result = await handler(params);
    if (method === "chat.send") {
      const runId = (result as { runId: string }).runId; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- chat.send handler always returns { runId: string }; narrowed by method === "chat.send" guard
      this.scheduleChatFrames(runId);
    }
    return result;
  }

  async sessionsCreate(params: {
    key?: string;
    label?: string;
    model?: string;
    agentId?: string;
  }): Promise<{ key: string; sessionId: string }> {
    return (await this.request("sessions.create", params)) as { key: string; sessionId: string }; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; mock handler always returns the correct shape
  }

  async sessionsList(params: { limit?: number } = {}): Promise<{
    sessions: Array<Record<string, unknown>>;
  }> {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; mock handler always returns { sessions: [] }
    return (await this.request("sessions.list", params)) as {
      sessions: Array<Record<string, unknown>>;
    };
  }

  async sessionsDelete(params: {
    key: string;
    deleteTranscript?: boolean;
  }): Promise<{ ok: boolean; key: string; deleted: boolean }> {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; mock handler always returns the correct shape
    return (await this.request("sessions.delete", params)) as {
      ok: boolean;
      key: string;
      deleted: boolean;
    };
  }

  async sessionsPatch(params: {
    key: string;
    label?: string;
    model?: string;
  }): Promise<{ ok: boolean }> {
    return (await this.request("sessions.patch", params)) as { ok: boolean }; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; mock handler always returns { ok: true }
  }

  async chatHistory(params: {
    sessionKey: string;
    limit?: number;
  }): Promise<{ messages: Array<Record<string, unknown>> }> {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; mock handler always returns { messages: [] }
    return (await this.request("chat.history", params)) as {
      messages: Array<Record<string, unknown>>;
    };
  }

  async chatSend(params: {
    message: string;
    sessionKey: string;
    idempotencyKey: string;
  }): Promise<{ runId: string }> {
    return (await this.request("chat.send", params)) as { runId: string }; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- mock handler always returns a runId
  }

  async chatAbort(params: {
    sessionKey: string;
    runId: string;
  }): Promise<{ ok: boolean; aborted: boolean; runIds: string[] }> {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; mock handler always returns the correct shape
    return (await this.request("chat.abort", params)) as {
      ok: boolean;
      aborted: boolean;
      runIds: string[];
    };
  }

  async modelsList(): Promise<{ models: Array<{ id: string; name: string }> }> {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; mock handler always returns { models: [...] }
    return (await this.request("models.list", {})) as {
      models: Array<{ id: string; name: string }>;
    };
  }

  async sessionsSubscribe(
    _onChange: (evt: {
      reason: "create" | "patch" | "delete" | "compact" | "reset";
      sessionKey: string;
      session?: Record<string, unknown>;
    }) => void,
  ): Promise<() => void> {
    await this.request("sessions.subscribe", {});
    // v1 mock never pushes sessions.changed, so the change callback is
    // intentionally never invoked. Returns a no-op unsubscribe for parity
    // with the real client's shape.
    return () => {};
  }

  private scheduleChatFrames(runId: string): void {
    const frames = this.scenario.chatFrames ?? [];
    let cumulative = 0;
    for (const frame of frames) {
      cumulative += frame.delay;
      const captured = frame;
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        if (!this.connected) return;
        this.emit(captured, runId);
      }, cumulative);
      this.pendingTimers.add(timer);
    }
  }

  private emit(frame: GatewayTestFrame, runId: string): void {
    const payload = substituteRunId(frame.payload, runId);
    for (const listener of this.listeners) {
      try {
        listener(frame.eventName, payload);
      } catch (err) {
        log.warn("event listener threw:", err);
      }
    }
  }

  private emitState(state: ConnectionState): void {
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch (err) {
        log.warn("state listener threw:", err);
      }
    }
  }
}
