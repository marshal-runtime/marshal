/**
 * GatewayWsClient — WebSocket client for the Marshal Gateway protocol.
 *
 * Manages the Ed25519 device-identity handshake, JSON-envelope RPC
 * (request → response matching by ID), and server-push event dispatch.
 */

import { randomUUID } from "crypto";

import WebSocket from "ws";

import { createLogger } from "../../../common/marshal-logger";
import type { DeviceIdentity, SignedChallenge } from "./device-identity";
import {
  NODE_ROLE,
  NODE_SCOPES,
  OPERATOR_ROLE,
  OPERATOR_SCOPES,
  signChallenge,
} from "./device-identity";

const log = createLogger("GatewayWsClient", { timestamps: true });

// ── Public types ──────────────────────────────────────────────────────────────

export type ConnectionState = "connecting" | "connected" | "disconnected";
type StateChangeListener = (state: ConnectionState) => void;

export class GatewayProtocolError extends Error {
  readonly name = "GatewayProtocolError";
  constructor(
    readonly method: string,
    readonly rawPayload: unknown,
  ) {
    super(`[gateway-ws] Protocol error on ${method}: response shape did not validate`);
  }
}

export class GatewayRpcError extends Error {
  readonly name = "GatewayRpcError";
  constructor(
    readonly method: string,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfterMs?: number,
  ) {
    super(`[gateway-ws] ${method} failed (${code}): ${message}`);
  }
}

/** Thrown by `connect()` when the gateway responds with NOT_PAIRED — caller
 *  enters a pairing-poll loop. `requestId` is the operator-approval handle
 *  (e.g. `marshal nodes approve <requestId>`). */
export class GatewayPairingRequiredError extends Error {
  readonly name = "GatewayPairingRequiredError";
  constructor(readonly requestId: string) {
    super(`[gateway-ws] pairing required (requestId=${requestId})`);
  }
}

export type GatewayRole = typeof OPERATOR_ROLE | typeof NODE_ROLE;

export interface GatewayRoleConfig {
  role: GatewayRole;
  scopes: ReadonlyArray<string>;
  clientMode: string;
  commands?: ReadonlyArray<string>;
  caps?: ReadonlyArray<string>;
  displayName?: string;
}

export interface GatewayExecutionProtocolCapabilitiesV1 {
  version: 1;
  maxConcurrentRuns: number;
  runCorrelation: "runId";
  cancellation: "runId";
  idempotency: "idempotencyKey";
  eventSequence: "seq" | "transport-order";
  startAck: "before-events";
}

export type GatewayExecutionProtocolCapabilities =
  | GatewayExecutionProtocolCapabilitiesV1
  | {
      version: 0;
      maxConcurrentRuns: 1;
      runCorrelation: "legacy-single-run";
      cancellation: "runId";
      idempotency: "idempotencyKey";
      eventSequence: "transport-order";
      startAck: "unspecified";
    };

export const LEGACY_GATEWAY_EXECUTION_CAPABILITIES: GatewayExecutionProtocolCapabilities = {
  version: 0,
  maxConcurrentRuns: 1,
  runCorrelation: "legacy-single-run",
  cancellation: "runId",
  idempotency: "idempotencyKey",
  eventSequence: "transport-order",
  startAck: "unspecified",
};

function parseExecutionProtocolCapabilities(
  payload: Record<string, unknown> | undefined,
): GatewayExecutionProtocolCapabilities {
  const capabilities = payload?.["capabilities"];
  if (!isRecord(capabilities)) return LEGACY_GATEWAY_EXECUTION_CAPABILITIES;
  const execution = capabilities["execution"];
  if (!isRecord(execution)) return LEGACY_GATEWAY_EXECUTION_CAPABILITIES;

  const maxConcurrentRuns = execution["maxConcurrentRuns"];
  if (
    execution["version"] !== 1 ||
    typeof maxConcurrentRuns !== "number" ||
    !Number.isSafeInteger(maxConcurrentRuns) ||
    maxConcurrentRuns < 1 ||
    execution["runCorrelation"] !== "runId" ||
    execution["cancellation"] !== "runId" ||
    execution["idempotency"] !== "idempotencyKey" ||
    (execution["eventSequence"] !== "seq" && execution["eventSequence"] !== "transport-order") ||
    execution["startAck"] !== "before-events"
  ) {
    return LEGACY_GATEWAY_EXECUTION_CAPABILITIES;
  }

  return {
    version: 1,
    maxConcurrentRuns,
    runCorrelation: "runId",
    cancellation: "runId",
    idempotency: "idempotencyKey",
    eventSequence: execution["eventSequence"],
    startAck: "before-events",
  };
}

export const OPERATOR_ROLE_CONFIG: GatewayRoleConfig = {
  role: OPERATOR_ROLE,
  scopes: OPERATOR_SCOPES,
  clientMode: "backend",
  // Opt this connection into gateway tool-event forwarding (marshal
  // server-chat.ts filters by this cap). Node-role connects don't process
  // `agent` stream events, so they don't declare the cap.
  caps: ["tool-events"],
};

export function nodeRoleConfig(
  commands: ReadonlyArray<string>,
  displayName?: string,
): GatewayRoleConfig {
  return {
    role: NODE_ROLE,
    scopes: NODE_SCOPES,
    clientMode: "node",
    commands,
    ...(displayName !== undefined && displayName.length > 0 ? { displayName } : {}),
  };
}

/**
 * Public surface of the WS client used by `GatewayBackend` and its sub-backends.
 * Lets the production `GatewayWsClient` and the E2E `MockGatewayWsClient` share
 * a single typed contract. Every method here is already implemented by
 * `GatewayWsClient`; the interface is extraction-only.
 */
export interface IGatewayWsClient {
  connect(): Promise<void>;
  close(): void;
  isConnected(): boolean;
  getExecutionCapabilities(): GatewayExecutionProtocolCapabilities;

  onStateChange(listener: (state: ConnectionState) => void): () => void;
  onEvent(listener: (eventName: string, payload: Record<string, unknown>) => void): () => void;

  request(method: string, params: Record<string, unknown>): Promise<unknown>;

  registerInboundHandler(
    method: string,
    handler: (params: Record<string, unknown>) => Promise<unknown>,
  ): () => void;

  sessionsCreate(params: {
    key?: string;
    label?: string;
    model?: string;
    agentId?: string;
  }): Promise<{ key: string; sessionId: string }>;

  sessionsList(params?: { limit?: number }): Promise<{
    sessions: Array<Record<string, unknown>>;
  }>;

  sessionsDelete(params: {
    key: string;
    deleteTranscript?: boolean;
  }): Promise<{ ok: boolean; key: string; deleted: boolean }>;

  sessionsPatch(params: { key: string; label?: string; model?: string }): Promise<{ ok: boolean }>;

  sessionsSubscribe(
    onChange: (evt: {
      reason: "create" | "patch" | "delete" | "compact" | "reset";
      sessionKey: string;
      session?: Record<string, unknown>;
    }) => void,
  ): Promise<() => void>;

  chatHistory(params: {
    sessionKey: string;
    limit?: number;
  }): Promise<{ messages: Array<Record<string, unknown>> }>;

  chatSend(params: {
    message: string;
    sessionKey: string;
    idempotencyKey: string;
  }): Promise<{ runId: string }>;

  chatAbort(params: {
    sessionKey: string;
    runId: string;
  }): Promise<{ ok: boolean; aborted: boolean; runIds: string[] }>;

  modelsList(): Promise<{ models: Array<{ id: string; name: string }> }>;
}

export interface GatewayWsClientConfig {
  url: string;
  gatewayToken: string;
  deviceIdentity: DeviceIdentity;
  roleConfig?: GatewayRoleConfig;
  clientName?: string;
  clientVersion?: string;
  platform?: string;
  rpcTimeoutMs?: number;
  /** default 180_000 ms — matches the hosted Aether runtime's
   *  ``marshal.health_timeout_seconds = 180``.
   *
   *  Why this long: against the hosted runtime the WS upgrade chain is
   *  two-hop and only the first hop completes immediately:
   *
   *    client → runtime            : WS upgrade accepted (HTTP 101)
   *    runtime → marshal container: WS upgrade retried (HTTP 503,
   *                                   ~2 s between attempts) until the
   *                                   per-tenant marshal container's
   *                                   Node.js process finishes
   *                                   post-seeding
   *    container → runtime → client: connect.challenge once the inner
   *                                   upgrade succeeds
   *
   *  Typical normal-path cold-starts measure ~13 s (attempts 1–7), but
   *  we've seen real-world incidents where the inner container takes
   *  closer to 60-180 s to come up. Earlier values (8 s → 60 s) were
   *  surfacing those legitimate cold-starts as "handshake timed out"
   *  errors that the user couldn't distinguish from a true wedge.
   *  Pinning the ceiling to the runtime's own health budget means: if
   *  *we* time out, the runtime has by definition also given up — so
   *  the error message reflects a real failure rather than premature
   *  impatience. Local runtimes are warm and respond in
   *  ~1 s, so the long default has no steady-state cost there. */
  challengeTimeoutMs?: number;
  /** Optional auth token sent as Authorization: Bearer header on the WS upgrade request.
   * Used by the runtime proxy for routing (AAD JWT in production, bypassed in local dev). */
  authToken?: string;
}

type EventListener = (eventName: string, payload: Record<string, unknown>) => void;

/** Handler for inbound RPC requests (server-initiated calls into the desktop). */
type InboundHandler = (params: Record<string, unknown>) => Promise<unknown>;

// ── Internal wire types ───────────────────────────────────────────────────────

interface WireRequest {
  type: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface WireResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { message: string; code: string; details?: Record<string, unknown> };
}

interface WireEvent {
  type: "event";
  event: string;
  payload: Record<string, unknown>;
}

type WireMessage = WireRequest | WireResponse | WireEvent;

const RATE_LIMIT_RETRY_MAX_ATTEMPTS = 3;
const RATE_LIMIT_RETRY_INITIAL_MS = 500;
const RATE_LIMIT_RETRY_MAX_MS = 10_000;
const RATE_LIMIT_RETRY_JITTER_MS = 250;

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  startedAtMs: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a ws RawData value (Buffer | ArrayBuffer | Buffer[]) to a UTF-8 string. */
function rawDataToString(raw: WebSocket.RawData): string {
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  // ArrayBuffer
  return Buffer.from(raw).toString("utf8");
}

/** Parse a raw WebSocket message into a WireMessage, or return null on failure. */
function parseWireMessage(raw: WebSocket.RawData): WireMessage | null {
  const text = rawDataToString(raw);
  const parsed: unknown = JSON.parse(text); // SF-4: remote gateway server message — parsed to unknown and narrowed by type guard below
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    typeof (parsed as Record<string, unknown>)["type"] !== "string"
  ) {
    return null;
  }
  // The full shape is validated at each call site via discriminated `type` checks.
  return parsed as WireMessage; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed above: type field verified to be a string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseRetryAfterMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function retryAfterMsFromDetails(details: Record<string, unknown> | undefined): number | undefined {
  if (!details) return undefined;
  const direct =
    parseRetryAfterMs(details["retryAfterMs"]) ??
    parseRetryAfterMs(details["retry_after_ms"]) ??
    parseRetryAfterMs(details["retryAfter"]) ??
    parseRetryAfterMs(details["retry_after"]) ??
    (typeof details["retryAfterSeconds"] === "number"
      ? details["retryAfterSeconds"] * 1000
      : undefined);
  if (direct !== undefined) return direct;

  const headers = details["headers"];
  if (!isRecord(headers)) return undefined;
  return (
    parseRetryAfterMs(headers["retry-after"]) ??
    parseRetryAfterMs(headers["Retry-After"]) ??
    parseRetryAfterMs(headers["x-ratelimit-reset-after"])
  );
}

function isRateLimitError(err: unknown): err is GatewayRpcError {
  if (!(err instanceof GatewayRpcError)) return false;
  const code = err.code.toLowerCase();
  const message = err.message.toLowerCase();
  return (
    code === "429" ||
    code.includes("rate") ||
    code.includes("throttl") ||
    message.includes("rate limit") ||
    message.includes("rate-limit") ||
    message.includes("throttl") ||
    message.includes("too many requests")
  );
}

function rateLimitDelayMs(err: GatewayRpcError, attempt: number): number {
  const retryAfterMs = err.retryAfterMs ?? retryAfterMsFromDetails(err.details);
  if (retryAfterMs !== undefined) return retryAfterMs;
  const backoffMs = Math.min(RATE_LIMIT_RETRY_INITIAL_MS * 2 ** attempt, RATE_LIMIT_RETRY_MAX_MS);
  return backoffMs + Math.floor(Math.random() * RATE_LIMIT_RETRY_JITTER_MS);
}

// ── GatewayWsClient ───────────────────────────────────────────────────────────

export class GatewayWsClient implements IGatewayWsClient {
  private readonly config: Required<Omit<GatewayWsClientConfig, "authToken">> &
    Pick<GatewayWsClientConfig, "authToken">;
  private ws: WebSocket | null = null;
  private connected = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<EventListener>();
  private readonly stateListeners = new Set<StateChangeListener>();
  private executionCapabilities: GatewayExecutionProtocolCapabilities =
    LEGACY_GATEWAY_EXECUTION_CAPABILITIES;
  /**
   * Inbound RPC dispatch table — server-initiated `req` messages route here
   * by `method`. Used by the DesktopCapabilities bridge so marshal can call
   * `desktop.executeLocalTool` etc. into the desktop. One handler per method.
   */
  private readonly inboundHandlers = new Map<string, InboundHandler>();

  /**
   * Defense-in-depth cap on concurrent inbound RPCs. Threat model: marshal
   * is authenticated, but a compromised or buggy peer could flood thousands
   * of `desktop.showApprovalCard` requests, each blocking on
   * `broker.requestPrompt()` for up to its auto-deny TTL. Memory and the
   * pending-prompt map grow with in-flight count.
   *
   * The desktop also expects marshal to bound this server-side; treating
   * this as belt-and-suspenders. Hitting the cap → respond with the
   * `not-supported` envelope so the cloud can back off.
   */
  private static readonly MAX_INBOUND_PENDING = 32;
  private inboundPending = 0;

  constructor(config: GatewayWsClientConfig) {
    this.config = {
      clientName: "gateway-client",
      clientVersion: "1.0.0",
      platform: process.platform,
      rpcTimeoutMs: 30_000,
      challengeTimeoutMs: 180_000,
      roleConfig: OPERATOR_ROLE_CONFIG,
      ...config,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Register a listener for connection state changes.
   * Returns an unsubscribe function.
   */
  onStateChange(listener: StateChangeListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /**
   * Open the WebSocket, complete the Marshal connect handshake, and resolve
   * when the server confirms the connection.  Rejects on timeout or error.
   */
  async connect(): Promise<void> {
    this.executionCapabilities = LEGACY_GATEWAY_EXECUTION_CAPABILITIES;
    const role = this.config.roleConfig ?? OPERATOR_ROLE_CONFIG;
    log.info(
      `connecting role=${role.role} url=${this.config.url} authToken=${this.config.authToken ? "present" : "absent"}`,
    );
    const ws = this.createWebSocket();
    try {
      await this.waitForOpen(ws);
    } catch (err) {
      log.warn(`connect failed at WS open url=${this.config.url}:`, err);
      throw err;
    }
    this.emitState("connecting");
    let challenge: { nonce: string; ts: number };
    try {
      challenge = await this.waitForChallenge(ws);
    } catch (err) {
      log.warn(`connect failed waiting for challenge url=${this.config.url}:`, err);
      throw err;
    }
    const signed = signChallenge(
      this.config.deviceIdentity,
      { ...challenge, token: this.config.gatewayToken },
      {
        clientName: this.config.clientName,
        clientMode: role.clientMode,
        role: role.role,
        scopes: role.scopes,
      },
    );
    const connectId = this.sendConnectRequest(ws, signed, challenge.nonce, role);
    this.executionCapabilities = await this.waitForConnectResponse(ws, connectId);

    // Handshake complete — switch to normal message handling.
    ws.removeAllListeners("message");
    ws.on("message", this.handleMessage.bind(this));
    // Attach an `error` listener. The waitFor* helpers each installed their
    // own `once("error")` during the handshake phase, but those are removed
    // once the handshake resolves. Without a replacement handler, Node crashes
    // the process on any EventEmitter "error" event — and the `ws` library
    // fires `error` before `close` on abnormal disconnects (ECONNRESET, TLS
    // failures, etc.). We let the close handler do the actual cleanup; this
    // listener's only job is to keep the process alive.
    ws.on("error", (err) => {
      log.warn("WebSocket error:", err);
    });
    ws.on("close", (code, reason) => {
      // Guard against a double "disconnected" event when close() was called
      // explicitly — close() already fires emitState synchronously, and then
      // the socket's "close" event fires asynchronously. Listeners expect a
      // single state transition per close.
      if (!this.connected) return;
      this.connected = false;
      this.emitState("disconnected");
      this.rejectAll(
        new Error(
          `[gateway-ws] Connection closed (code=${code}, reason=${rawDataToString(reason)})`,
        ),
      );
    });
    this.ws = ws;
    this.connected = true;
    this.startPingInterval();
    this.emitState("connected");
  }

  /**
   * Send an RPC request and return the response payload.
   * Rejects if the server returns `ok: false` or the request times out.
   */
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || !this.ws) {
      throw new Error("[gateway-ws] Not connected");
    }

    for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.sendRequestOnce(method, params); // oxlint-disable-line no-await-in-loop -- retries must wait for each prior request to fail
      } catch (err) {
        if (!isRateLimitError(err)) throw err;
        if (attempt >= RATE_LIMIT_RETRY_MAX_ATTEMPTS) {
          throw new GatewayRpcError(
            method,
            err.code,
            `rate limit retry budget exhausted after ${attempt + 1} attempts: ${err.message}`,
            err.details,
            err.retryAfterMs,
          );
        }
        const delayMs = rateLimitDelayMs(err, attempt);
        log.warn(
          `rate-limited ${method}; retrying in ${delayMs}ms (attempt ${attempt + 1}/${RATE_LIMIT_RETRY_MAX_ATTEMPTS})`,
        );
        await sleep(delayMs); // oxlint-disable-line no-await-in-loop -- intentional rate-limit backoff
        if (!this.connected || !this.ws) {
          throw new Error("[gateway-ws] Not connected", { cause: err });
        }
      }
    }

    throw new Error(`[gateway-ws] Request failed: ${method}`);
  }

  private sendRequestOnce(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      const { rpcTimeoutMs } = this.config;

      const timer = setTimeout(() => {
        this.pending.delete(id);
        log.warn(`→ req timed out: ${method} (id=${id.slice(0, 8)})`);
        reject(new Error(`[gateway-ws] Request timed out: ${method}`));
      }, rpcTimeoutMs);

      const startedAtMs = Date.now();
      this.pending.set(id, { resolve, reject, timer, method, startedAtMs });

      const req: WireRequest = { type: "req", id, method, params };
      // Method + paramKeys only — params can carry user prompts.
      log.info(
        `→ req ${method} (id=${id.slice(0, 8)}, paramKeys=${Object.keys(params).join(",")})`,
      );
      this.ws!.send(JSON.stringify(req)); // oxlint-disable-line @typescript-eslint/no-non-null-assertion -- guarded by isConnected check above
    });
  }

  // ── Typed RPC helpers ───────────────────────────────────────────────────────
  // Each helper is a thin wrapper over `request()`. Validation here is minimal:
  // we check the fields we actually read and throw GatewayProtocolError on
  // mismatch. Business-level errors from the server still surface as plain
  // Error via the underlying request() path (ok:false → rejection).

  async sessionsCreate(params: {
    key?: string;
    label?: string;
    model?: string;
    agentId?: string;
  }): Promise<{ key: string; sessionId: string }> {
    const raw = (await this.request("sessions.create", params)) as Record<string, unknown>; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; narrowed by typeof guards below
    const key = typeof raw.key === "string" ? raw.key : null;
    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : null;
    if (!key || !sessionId) {
      throw new GatewayProtocolError("sessions.create", raw);
    }
    return { key, sessionId };
  }

  async sessionsList(params: { limit?: number } = {}): Promise<{
    sessions: Array<Record<string, unknown>>;
  }> {
    const raw = (await this.request("sessions.list", params)) as Record<string, unknown>; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; narrowed by Array.isArray guard below
    if (!Array.isArray(raw.sessions)) {
      throw new GatewayProtocolError("sessions.list", raw);
    }
    return { sessions: raw.sessions as Array<Record<string, unknown>> }; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- guarded by Array.isArray above
  }

  async sessionsDelete(params: {
    key: string;
    deleteTranscript?: boolean;
  }): Promise<{ ok: boolean; key: string; deleted: boolean }> {
    const raw = (await this.request("sessions.delete", params)) as Record<string, unknown>; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; narrowed by typeof guards below
    return {
      ok: raw.ok === true,
      key: typeof raw.key === "string" ? raw.key : params.key,
      deleted: raw.deleted === true,
    };
  }

  async sessionsPatch(params: {
    key: string;
    label?: string;
    model?: string;
  }): Promise<{ ok: boolean }> {
    const raw = (await this.request("sessions.patch", params)) as Record<string, unknown>; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; narrowed by ok check below
    return { ok: raw.ok === true };
  }

  async chatHistory(params: {
    sessionKey: string;
    limit?: number;
  }): Promise<{ messages: Array<Record<string, unknown>> }> {
    const raw = (await this.request("chat.history", params)) as Record<string, unknown>; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; narrowed by Array.isArray guard below
    if (!Array.isArray(raw.messages)) {
      throw new GatewayProtocolError("chat.history", raw);
    }
    return { messages: raw.messages as Array<Record<string, unknown>> }; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- guarded by Array.isArray above
  }

  async chatSend(params: {
    message: string;
    sessionKey: string;
    idempotencyKey: string;
  }): Promise<{ runId: string }> {
    const raw = (await this.request("chat.send", params)) as Record<string, unknown>; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; narrowed by the runId guard below
    if (typeof raw.runId !== "string" || raw.runId.length === 0) {
      throw new GatewayProtocolError("chat.send", raw);
    }
    return { runId: raw.runId };
  }

  async chatAbort(params: {
    sessionKey: string;
    runId: string;
  }): Promise<{ ok: boolean; aborted: boolean; runIds: string[] }> {
    const raw = (await this.request("chat.abort", params)) as Record<string, unknown>; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; narrowed by typeof/=== guards below
    return {
      ok: raw.ok === true,
      aborted: raw.aborted === true,
      runIds: Array.isArray(raw.runIds) ? (raw.runIds as string[]) : [], // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- guarded by Array.isArray above
    };
  }

  async modelsList(): Promise<{ models: Array<{ id: string; name: string }> }> {
    const raw = (await this.request("models.list", {})) as Record<string, unknown>; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- request() returns unknown; narrowed by Array.isArray guard below
    if (!Array.isArray(raw.models)) {
      throw new GatewayProtocolError("models.list", raw);
    }
    // We intentionally only promote `id` and `name` to the typed surface; the
    // backend filters/enriches these into the ModelInfo shape the renderer
    // consumes. Raw rows carry more fields (provider, deprecation, etc.).
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- guarded by Array.isArray above
    const rawModels = raw.models as Array<Record<string, unknown>>;
    const models = rawModels.map((m) => ({
      id: typeof m.id === "string" ? m.id : "",
      name: typeof m.name === "string" ? m.name : typeof m.id === "string" ? m.id : "",
    }));
    return { models };
  }

  /**
   * Open the live subscription to session-list changes. The callback fires
   * for every `sessions.changed` server-push event. Returns an unsubscribe
   * function that detaches the event listener — note the server-side
   * subscription stays active until the WebSocket closes; there is no
   * `sessions.unsubscribe` in Slice 1 since the client owns the lifetime.
   */
  async sessionsSubscribe(
    onChange: (evt: {
      reason: "create" | "patch" | "delete" | "compact" | "reset";
      sessionKey: string;
      session?: Record<string, unknown>;
    }) => void,
  ): Promise<() => void> {
    await this.request("sessions.subscribe", {});
    const unsubEvent = this.onEvent((eventName, payload) => {
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
      const session =
        typeof payload.session === "object" && payload.session !== null
          ? (payload.session as Record<string, unknown>) // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof+null check above
          : undefined;
      onChange({ reason, sessionKey, session });
    });
    return unsubEvent;
  }

  /**
   * Register a listener for server-push events.
   * Returns an unsubscribe function.
   */
  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Register a handler for an inbound RPC method (server → desktop calls).
   *
   * Used by the DesktopCapabilities bridge: marshal sends `{ type: "req",
   * method: "desktop.executeLocalTool", ... }` and we route to the registered
   * handler, then ship its return value back as a `res` over the same socket.
   *
   * Throws if `method` is already registered — there is exactly one owner per
   * method name. Returns an unregister function.
   */
  registerInboundHandler(method: string, handler: InboundHandler): () => void {
    if (this.inboundHandlers.has(method)) {
      throw new Error(`[gateway-ws] inbound handler for "${method}" already registered`);
    }
    this.inboundHandlers.set(method, handler);
    return () => {
      this.inboundHandlers.delete(method);
    };
  }

  /** Close the WebSocket and reject all pending requests. */
  close(): void {
    this.connected = false;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.emitState("disconnected");
    const err = new Error("[gateway-ws] Client closed");
    this.rejectAll(err);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Returns true when the handshake has completed and the socket is open. */
  isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getExecutionCapabilities(): GatewayExecutionProtocolCapabilities {
    return this.executionCapabilities;
  }

  // ── Handshake helpers ──────────────────────────────────────────────────────

  /** Create a WebSocket with the configured URL and optional auth header. */
  private createWebSocket(): WebSocket {
    const headers: Record<string, string> = {};
    if (this.config.authToken) {
      headers["Authorization"] = `Bearer ${this.config.authToken}`;
    }
    return new WebSocket(this.config.url, { headers });
  }

  /** Wait for the WebSocket to open, or reject on error. */
  private waitForOpen(ws: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.off("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        ws.off("open", onOpen);
        reject(this.enrichConnectError(err));
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  /** Hint for the case where someone's still running the bare gateway on
   *  ws://localhost:18789 — the 0.21.x default — after the local default
   *  flipped to ws://localhost:8001/v1/marshal-gateway. */
  private enrichConnectError(err: Error): Error {
    const message = err.message;
    if (!message) return err;
    const url = this.config.url;
    const isLocalhost = /:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url);
    if (!isLocalhost) return err;
    if (!/Unexpected server response: 403/i.test(message)) return err;
    return new Error(
      `${message}\n` +
        `Connecting to ${url}. The local-runtime default changed in this branch — ` +
        `if you are running the bare gateway on ws://localhost:18789, set ` +
        `MARSHAL_GATEWAY_URL=ws://localhost:18789 to override the new default.`,
    );
  }

  /** Wait for the server's connect.challenge event. On timeout, the
   *  rejection embeds the most-recent unexpected message so wedge debugging
   *  doesn't need debug-level handshake tracing. */
  private waitForChallenge(ws: WebSocket): Promise<{ nonce: string; ts: number }> {
    const { challengeTimeoutMs, url } = this.config;
    return new Promise<{ nonce: string; ts: number }>((resolve, reject) => {
      let lastUnexpected: { type?: string; event?: string; raw?: string } | null = null;

      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        ws.terminate();
        const tail = lastUnexpected
          ? lastUnexpected.raw !== undefined
            ? ` — last unexpected payload: ${lastUnexpected.raw.slice(0, 200)}`
            : ` — last unexpected message: type=${lastUnexpected.type ?? "?"} event=${lastUnexpected.event ?? "?"}`
          : " — no messages received before deadline";
        reject(
          new Error(
            `Gateway connect handshake timed out waiting for challenge after ${challengeTimeoutMs}ms (url=${url})${tail}`,
          ),
        );
      }, challengeTimeoutMs);

      const onMessage = (raw: WebSocket.RawData): void => {
        let msg: WireMessage | null;
        try {
          msg = parseWireMessage(raw);
        } catch {
          const rawStr = rawDataToString(raw);
          log.warn("Failed to parse handshake message:", rawStr);
          lastUnexpected = { raw: rawStr };
          return;
        }

        if (msg === null || msg.type !== "event" || msg.event !== "connect.challenge") {
          log.warn("Unexpected handshake message:", msg);
          lastUnexpected = msg
            ? { type: msg.type, event: "event" in msg ? msg.event : undefined }
            : null;
          return;
        }

        ws.off("message", onMessage);
        clearTimeout(timer);

        const payload = msg.payload;
        const nonce = typeof payload["nonce"] === "string" ? payload["nonce"] : "";
        const ts = typeof payload["ts"] === "number" ? payload["ts"] : 0;
        resolve({ nonce, ts });
      };

      const onError = (err: Error): void => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        reject(err);
      };

      ws.on("message", onMessage);
      ws.once("error", onError);
    });
  }

  /** Send the connect request and return the request ID for response matching. */
  private sendConnectRequest(
    ws: WebSocket,
    signed: SignedChallenge,
    nonce: string,
    roleConfig: GatewayRoleConfig,
  ): string {
    const connectId = randomUUID();
    const client: Record<string, unknown> = {
      id: this.config.clientName,
      version: this.config.clientVersion,
      platform: this.config.platform,
      mode: roleConfig.clientMode,
    };
    if (roleConfig.displayName !== undefined) {
      client["displayName"] = roleConfig.displayName;
    }
    const params: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 3,
      client,
      role: roleConfig.role,
      scopes: roleConfig.scopes,
      auth: { token: this.config.gatewayToken },
      device: {
        id: signed.deviceId,
        publicKey: signed.publicKeyBase64url,
        signature: signed.signatureBase64url,
        signedAt: signed.signedAt,
        nonce,
      },
    };
    // Gateway schema rejects unknown keys for operator role on some versions;
    // omit per-role fields rather than send undefined.
    if (roleConfig.commands !== undefined) {
      params["commands"] = roleConfig.commands;
    }
    if (roleConfig.caps !== undefined) {
      params["caps"] = roleConfig.caps;
    }
    const connectReq: WireRequest = { type: "req", id: connectId, method: "connect", params };

    log.info(
      "Sending connect request:",
      JSON.stringify({
        role: roleConfig.role,
        deviceId: signed.deviceId,
        publicKey: signed.publicKeyBase64url.slice(0, 20) + "...",
        clientId: this.config.clientName,
        displayNameLength: roleConfig.displayName?.length ?? 0,
        nonce,
        ts: signed.signedAt,
        commandsCount: roleConfig.commands?.length ?? 0,
        commands: roleConfig.commands ? [...roleConfig.commands].slice(0, 32) : undefined,
      }),
    );
    ws.send(JSON.stringify(connectReq));
    return connectId;
  }

  /** Wait for the connect response matching the given request ID. */
  private waitForConnectResponse(
    ws: WebSocket,
    connectId: string,
  ): Promise<GatewayExecutionProtocolCapabilities> {
    const { rpcTimeoutMs } = this.config;
    return new Promise<GatewayExecutionProtocolCapabilities>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        ws.terminate();
        reject(new Error("Gateway connect handshake timed out waiting for connect response"));
      }, rpcTimeoutMs);

      const onMessage = (rawRes: WebSocket.RawData): void => {
        let res: WireMessage | null;
        try {
          res = parseWireMessage(rawRes);
        } catch {
          log.warn("Failed to parse connect response:", rawDataToString(rawRes));
          return;
        }

        if (res === null || res.type !== "res" || res.id !== connectId) {
          // Not the response we're waiting for — ignore and keep waiting.
          return;
        }

        ws.off("message", onMessage);
        clearTimeout(timer);

        if (!res.ok) {
          const errMsg = res.error?.message ?? "Connect rejected by server";
          const errCode = res.error?.code ?? "unknown";
          log.error("Connect rejected:", JSON.stringify(res.error));
          log.error("Full response:", rawDataToString(rawRes));
          // NOT_PAIRED → typed error so the backend drives the pairing-wait
          // loop instead of surfacing a generic connect failure.
          const details = res.error?.details;
          const detailRequestId =
            typeof details?.["requestId"] === "string" ? details["requestId"] : null;
          if (errCode === "NOT_PAIRED" && detailRequestId) {
            reject(new GatewayPairingRequiredError(detailRequestId));
            return;
          }
          reject(new Error(`[gateway-ws] Connect failed: ${errMsg} (code: ${errCode})`));
          return;
        }

        resolve(parseExecutionProtocolCapabilities(res.payload));
      };

      const onError = (err: Error): void => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        reject(err);
      };

      ws.on("message", onMessage);
      ws.once("error", onError);
    });
  }

  /** Start the keepalive ping interval (30s). */
  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
    }, 30_000);
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private emitState(state: ConnectionState): void {
    for (const listener of this.stateListeners) listener(state);
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let msg: WireMessage | null;
    try {
      msg = parseWireMessage(raw);
    } catch {
      log.warn("Failed to parse message:", rawDataToString(raw));
      return;
    }

    if (msg === null) {
      log.warn("Received null/invalid message");
      return;
    }

    if (msg.type === "res") {
      this.handleResponse(msg);
    } else if (msg.type === "event") {
      this.dispatchEvent(msg);
    } else if (msg.type === "req") {
      // Inbound server-initiated RPC. Dispatch async and never throw out of
      // the message handler — failures are reported via the response envelope.
      void this.handleInboundRequest(msg).catch((err) => {
        log.warn("Inbound request handler threw outside handler scope:", {
          err,
          method: msg.method,
        });
      });
    } else {
      log.warn("Unexpected message type:", (msg as WireMessage).type);
    }
  }

  private handleResponse(res: WireResponse): void {
    const pending = this.pending.get(res.id);
    if (!pending) {
      log.warn(`← res for unknown id=${res.id.slice(0, 8)} (likely arrived after timeout)`);
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(res.id);

    const elapsedMs = Date.now() - pending.startedAtMs;
    if (res.ok) {
      // Top-level keys only — payloads can carry large bodies / user content.
      const keys = res.payload ? Object.keys(res.payload).join(",") : "(none)";
      log.info(
        `← res ok ${pending.method} (id=${res.id.slice(0, 8)}, ${elapsedMs}ms) payloadKeys=${keys}`,
      );
      pending.resolve(res.payload ?? {});
    } else {
      const errMsg = res.error?.message ?? "Request failed";
      const errCode = res.error?.code ?? "unknown";
      const details = res.error?.details;
      const retryAfterMs = retryAfterMsFromDetails(details);
      log.info(
        `← res FAIL ${pending.method} (id=${res.id.slice(0, 8)}, ${elapsedMs}ms) code=${errCode} msg=${errMsg}`,
      );
      pending.reject(new GatewayRpcError(pending.method, errCode, errMsg, details, retryAfterMs));
    }
  }

  private dispatchEvent(msg: WireEvent): void {
    // Keys only — text-delta payloads carry large strings.
    const keys = Object.keys(msg.payload).join(",");
    const runId =
      typeof msg.payload["runId"] === "string" ? msg.payload["runId"].slice(0, 8) : "(none)";
    log.info(`← event ${msg.event} runId=${runId} keys=[${keys}]`);
    for (const listener of this.listeners) {
      try {
        listener(msg.event, msg.payload);
      } catch (err) {
        log.warn("Event listener threw:", err);
      }
    }
  }

  /**
   * Route an inbound `req` to its registered handler and ship the result back
   * over the wire as a `res`. Unknown methods → `not-supported`. Handler that
   * throws → `internal`. Errors are surfaced through the response envelope so
   * the server-side caller's request promise resolves rather than hangs.
   */
  private async handleInboundRequest(req: WireRequest): Promise<void> {
    if (this.inboundPending >= GatewayWsClient.MAX_INBOUND_PENDING) {
      // See MAX_INBOUND_PENDING declaration for rationale.
      log.warn("Inbound request rejected — concurrent cap reached:", {
        method: req.method,
        pending: this.inboundPending,
      });
      this.sendInboundResponse(req.id, false, undefined, {
        code: "not-supported",
        message: `Too many concurrent inbound requests (cap: ${GatewayWsClient.MAX_INBOUND_PENDING})`,
      });
      return;
    }
    const handler = this.inboundHandlers.get(req.method);
    if (!handler) {
      log.warn("Inbound request for unknown method:", req.method);
      this.sendInboundResponse(req.id, false, undefined, {
        code: "not-supported",
        message: `Unknown method: ${req.method}`,
      });
      return;
    }
    this.inboundPending++;
    try {
      // `parseWireMessage` accepts `{type:"req", id, method}` with no params;
      // default to `{}` so handler factories don't `TypeError` on `request.X`
      // and surface that as the misleading `internal` error code.
      const payload = await handler(req.params ?? {});
      this.sendInboundResponse(req.id, true, payload);
    } catch (err) {
      log.warn("Inbound handler threw:", { method: req.method, err });
      // Honor a structured `code` on the thrown error so categories defined by
      // `DesktopCapabilityErrorThrow` (policy-deny, user-deny, tool-error,
      // auth-failed, not-supported, timeout) reach the wire. Plain `Error`
      // throws fall back to `internal`. The bridge layer is responsible for
      // throwing structured errors when the handler can classify the failure.
      const errWithCode =
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- read-only attribute probe to detect a structured error code; value is checked by the typeof guard below before use
        err instanceof Error ? (err as Error & { code?: unknown }) : null;
      const code =
        errWithCode !== null && typeof errWithCode.code === "string"
          ? errWithCode.code
          : "internal";
      this.sendInboundResponse(req.id, false, undefined, {
        code,
        message: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      this.inboundPending--;
    }
  }

  /**
   * Send a response to an inbound RPC. Mirrors the server's `WireResponse`
   * shape: `{ type: "res", id, ok, payload? | error? }`. The `payload` field
   * is widened to `unknown` for inbound responses (vs. `Record<string, unknown>`
   * on the type) — handlers may legitimately return primitives or arrays;
   * the runtime payload is JSON-serialized, so the wire shape remains valid.
   */
  private sendInboundResponse(
    id: string,
    ok: boolean,
    payload?: unknown,
    error?: { code: string; message: string },
  ): void {
    if (!this.ws) return;
    const res: Record<string, unknown> = { type: "res", id, ok };
    if (ok) {
      res["payload"] = payload;
    } else {
      res["error"] = error;
    }
    this.ws.send(JSON.stringify(res));
  }

  /** Reject all pending requests and clear the map. */
  private rejectAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}
