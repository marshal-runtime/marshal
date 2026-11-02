import type { GatewayAuthIdentity } from "../../../common/marshal-ipc-contract";
import { createLogger } from "../../../common/marshal-logger";
import { authErrors, makeAuthError } from "../../../common/telemetry/errors/marshal-auth";
import { sendErrorTelemetry } from "../../telemetry-errors";
import { PairingCancelledError } from "./auth/pairing-cancelled-error";
import { DeviceIdentityError, readDeviceIdentity, type DeviceIdentity } from "./device-identity";
import { GatewayNodeActivityJournal } from "./node/activity-journal";
import { GatewayPairingRequiredError, GatewayWsClient, nodeRoleConfig } from "./ws-client";

const log = createLogger("GatewayNodeBackend");

const PAIRING_RETRY_MS = 5_000;
/** Match Marshal's 5-min pending-request TTL. */
const PAIRING_TIMEOUT_MS = 5 * 60_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Slightly above marshal's ``NODE_PRESENCE_PERSIST_MIN_INTERVAL_MS``
 *  throttle (60 s exactly) so network jitter never pushes our send
 *  under the server's deadline. Observed on first runs: at a flat
 *  60_000 ms cadence every other ping landed at ~59.6 s server-side
 *  and was throttled, dropping the effective lastSeenAt update rate
 *  to once per ~120 s. 65 s gives ~5 s of slack with negligible
 *  steady-state cost (one extra ping per minute on the operator UI's
 *  view of "online"). */
const NODE_HEARTBEAT_INTERVAL_MS = 65_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface GatewayNodeBackendConfig {
  gatewayUrl: string;
  hostedGatewayUrl: string;
  deviceIdentityPath: string;
  gatewayToken: string;
}

export type InvokeHandler = (params: Record<string, unknown>) => Promise<unknown>;

interface StartOpts {
  cred: GatewayAuthIdentity;
  /** Called once per (re)connect attempt — refresh-per-attempt (vs cached at
   *  sign-in) so a WS death past AAD's ~1h TTL self-heals instead of spinning
   *  forever with a stale bearer. */
  acquireAuthToken: () => Promise<string | undefined>;
  commands: ReadonlyArray<string>;
}

export class GatewayNodeBackend {
  private readonly config: GatewayNodeBackendConfig;
  private readonly _activityLog = new GatewayNodeActivityJournal();

  getActivityLog(): Readonly<Pick<GatewayNodeActivityJournal, "getAll" | "subscribe">> {
    return this._activityLog;
  }

  getActivityLogForBridge(): GatewayNodeActivityJournal {
    return this._activityLog;
  }

  private client: GatewayWsClient | null = null;
  private cachedDeviceIdentity: DeviceIdentity | null = null;
  private deviceIdentityFailedEmitted = false;

  private lastStartOpts: StartOpts | null = null;
  private ready = false;

  private intentionalClose = false;
  private reconnecting = false;
  private reconnectLoopPromise: Promise<void> | null = null;

  private pairingWait: { requestId: string; aborted: boolean } | null = null;
  private pairingStatusCallback: ((requestId: string) => void) | null = null;
  private reconnectingChangeCallback: ((reconnecting: boolean) => void) | null = null;

  // Keep invokeHandler — the bridge attaches it once and doesn't re-register on reconnect.
  private invokeHandler: InvokeHandler | null = null;
  private unsubscribeInvokeEvent: (() => void) | null = null;

  private readonly connectedListeners = new Set<() => void>();

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** Mirror of ws-client's inboundPending cap — prevents a misbehaving peer from
   *  flooding node.invoke.request bursts. */
  private static readonly MAX_INVOKE_PENDING = 16;
  private invokePending = 0;

  constructor(config: GatewayNodeBackendConfig) {
    this.config = config;
  }

  async start(opts: StartOpts): Promise<void> {
    log.info(`start() role=node mode=${opts.cred.mode} commandCount=${opts.commands.length}`);
    this.lastStartOpts = opts;
    await this.stopReconnect();
    this.intentionalClose = true;
    try {
      if (this.client) {
        this.client.close();
        this.client = null;
        this.ready = false;
      }
    } finally {
      this.intentionalClose = false;
    }
    try {
      await this.openClient(opts);
    } catch (err) {
      if (err instanceof GatewayPairingRequiredError) {
        await this.runPairingLoop(err.requestId, opts);
      } else {
        throw err;
      }
    }
  }

  async stop(): Promise<void> {
    this.cancelPairing();
    this.stopHeartbeat();
    await this.stopReconnect();
    this.intentionalClose = true;
    try {
      if (this.unsubscribeInvokeEvent) {
        this.unsubscribeInvokeEvent();
        this.unsubscribeInvokeEvent = null;
      }
      if (this.client) {
        this.client.close();
        this.client = null;
      }
      this.ready = false;
      this.lastStartOpts = null;
      this._activityLog.clear();
    } finally {
      this.intentionalClose = false;
    }
  }

  isConnected(): boolean {
    return this.ready && (this.client?.isConnected() ?? false);
  }

  setReconnectingChangeCallback(callback: ((reconnecting: boolean) => void) | null): void {
    this.reconnectingChangeCallback = callback;
  }

  private setReconnectingState(value: boolean): void {
    if (this.reconnecting === value) return;
    this.reconnecting = value;
    if (this.reconnectingChangeCallback) {
      try {
        this.reconnectingChangeCallback(value);
      } catch (err) {
        log.warn("reconnectingChange callback threw:", err);
      }
    }
  }

  onConnected(callback: () => void): () => void {
    this.connectedListeners.add(callback);
    return () => {
      this.connectedListeners.delete(callback);
    };
  }

  setInvokeHandler(handler: InvokeHandler | null): void {
    this.invokeHandler = handler;
    if (this.client) {
      this.attachInvokeHandlerToCurrentClient();
    }
  }

  setPairingStatusCallback(callback: ((requestId: string) => void) | null): void {
    this.pairingStatusCallback = callback;
  }

  cancelPairing(): void {
    if (this.pairingWait) {
      this.pairingWait.aborted = true;
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async openClient(opts: StartOpts): Promise<void> {
    if (!this.cachedDeviceIdentity) {
      this.cachedDeviceIdentity = readDeviceIdentity(this.config.deviceIdentityPath);
    }

    const url = opts.cred.mode === "hosted" ? this.config.hostedGatewayUrl : this.config.gatewayUrl;
    const authToken = await opts.acquireAuthToken();
    const client = new GatewayWsClient({
      url,
      gatewayToken: this.config.gatewayToken,
      deviceIdentity: this.cachedDeviceIdentity,
      authToken,
      roleConfig: nodeRoleConfig(opts.commands, opts.cred.nodeName),
      // clientName left at the default ("gateway-client"): the gateway's connect
      // schema only accepts a fixed allow-list of client.id values; "gateway-node"
      // was rejected with INVALID_REQUEST. The role is already pinned by the signed
      // payload's role field.
    });

    client.onStateChange((state) => {
      if (state !== "disconnected") return;
      this.stopHeartbeat();
      if (this.intentionalClose) return;
      if (!this.reconnecting) {
        this.reconnect().catch((err) => log.error("node reconnect loop failed:", err));
      }
    });

    await client.connect();
    this.client = client;
    this.ready = true;
    this.attachInvokeHandlerToCurrentClient();

    for (const cb of this.connectedListeners) {
      try {
        cb();
      } catch (err) {
        log.warn("onConnected listener threw:", err);
      }
    }
    log.info("node connection ready");
    this.startHeartbeat(client);
  }

  getDeviceId(): string | null {
    return this.cachedDeviceIdentity?.deviceId ?? null;
  }

  private startHeartbeat(client: GatewayWsClient): void {
    this.stopHeartbeat();
    void this.sendPresenceAlive(client, "connect");
    this.heartbeatTimer = setInterval(() => {
      void this.sendPresenceAlive(client, "background");
    }, NODE_HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async sendPresenceAlive(
    client: GatewayWsClient,
    trigger: "connect" | "background",
  ): Promise<void> {
    if (this.client !== client) return; // stale client after reconnect
    try {
      const res = await client.request("node.event", {
        event: "node.presence.alive",
        payload: { trigger },
      });
      // Possible reason values from marshal handleNodeEvent: persisted, throttled,
      // unpaired, missing_device_identity, invalid_payload, persist_failed.
      const handled = isRecord(res) && res.handled === true;
      const reason = isRecord(res) && typeof res.reason === "string" ? res.reason : "?";
      if (handled && reason === "persisted") {
        log.info(`node.presence.alive (${trigger}) → persisted`);
      } else {
        log.warn(`node.presence.alive (${trigger}) → handled=${handled} reason=${reason}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`node.presence.alive (${trigger}) failed: ${msg.slice(0, 200)}`);
    }
  }

  // The gateway pushes invoke RPCs as EVENTs (node.invoke.request), not request/response.
  // We reply with an outbound node.invoke.result request.
  // Previously used registerInboundHandler("node.invoke") — wrong path; gateway never
  // reached us and the operator timed out at 30 s.
  private attachInvokeHandlerToCurrentClient(): void {
    if (!this.client) return;
    if (!this.invokeHandler) return;
    if (this.unsubscribeInvokeEvent) {
      this.unsubscribeInvokeEvent();
      this.unsubscribeInvokeEvent = null;
    }
    const client = this.client;
    this.unsubscribeInvokeEvent = client.onEvent((eventName, payload) => {
      if (eventName !== "node.invoke.request") return;
      if (this.invokePending >= GatewayNodeBackend.MAX_INVOKE_PENDING) {
        const id = typeof payload.id === "string" ? payload.id : "";
        const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : "";
        log.warn(
          `node.invoke.request rejected: ${this.invokePending} pending (cap ${GatewayNodeBackend.MAX_INVOKE_PENDING})`,
        );
        if (id) {
          void this.sendInvokeError(
            client,
            id,
            nodeId,
            "not-supported",
            `node busy: ${GatewayNodeBackend.MAX_INVOKE_PENDING} concurrent invocations cap reached`,
          );
        }
        return;
      }
      this.invokePending++;
      void this.handleInvokeEvent(client, payload).finally(() => {
        this.invokePending--;
      });
    });
  }

  private async handleInvokeEvent(
    client: GatewayWsClient,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const id = typeof payload.id === "string" ? payload.id : "";
    const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : "";
    const command = typeof payload.command === "string" ? payload.command : "";
    if (!id || !command) {
      log.warn(
        `node.invoke.request dropped (missing id or command): keys=${Object.keys(payload).join(",")}`,
      );
      return;
    }
    log.info(`node.invoke.request id=${id} command=${command}`);
    // paramsJSON is the canonical form; some marshal versions send params directly.
    let parsedParams: unknown;
    if (typeof payload.paramsJSON === "string") {
      try {
        parsedParams = JSON.parse(payload.paramsJSON) as unknown; // SF-4: parsed to unknown; bridge.handleInvoke is the validation boundary
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`node.invoke.request paramsJSON parse failed: ${msg}`);
        await this.sendInvokeError(client, id, nodeId, "bad-request", "paramsJSON not valid JSON");
        return;
      }
    } else if (payload.params !== undefined) {
      parsedParams = payload.params;
    }
    const args = isRecord(parsedParams) ? parsedParams : {};

    const handler = this.invokeHandler;
    if (!handler) {
      await this.sendInvokeError(client, id, nodeId, "not-supported", "node has no invoke handler");
      return;
    }

    let bridgeResult: unknown;
    try {
      bridgeResult = await handler({ command, invocationId: id, args });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`bridge invoke handler threw for ${command}: ${msg}`);
      await this.sendInvokeError(client, id, nodeId, "internal-error", msg);
      return;
    }

    await this.sendInvokeResult(client, id, nodeId, bridgeResult);
  }

  private async sendInvokeResult(
    client: GatewayWsClient,
    id: string,
    nodeId: string,
    bridgeResult: unknown,
  ): Promise<void> {
    if (this.client !== client) return; // stale
    const ok = isRecord(bridgeResult) && bridgeResult.ok === true;
    const errorMessage =
      isRecord(bridgeResult) && typeof bridgeResult.error === "string"
        ? bridgeResult.error
        : undefined;
    const errorCode =
      isRecord(bridgeResult) && typeof bridgeResult.code === "string"
        ? bridgeResult.code
        : undefined;

    const params: Record<string, unknown> = {
      id,
      nodeId,
      ok,
      payload: bridgeResult,
    };
    if (!ok) {
      const errObj: Record<string, string> = {};
      if (errorCode) errObj.code = errorCode;
      if (errorMessage) errObj.message = errorMessage;
      if (Object.keys(errObj).length > 0) params.error = errObj;
    }
    try {
      await client.request("node.invoke.result", params);
      log.info(`node.invoke.result id=${id} ok=${ok} sent`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`node.invoke.result failed (id=${id}): ${msg}`);
    }
  }

  private async sendInvokeError(
    client: GatewayWsClient,
    id: string,
    nodeId: string,
    code: string,
    message: string,
  ): Promise<void> {
    if (this.client !== client) return;
    try {
      await client.request("node.invoke.result", {
        id,
        nodeId,
        ok: false,
        error: { code, message },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`node.invoke.result (error report) failed (id=${id}): ${msg}`);
    }
  }

  private async runPairingLoop(initialRequestId: string, opts: StartOpts): Promise<void> {
    let requestId = initialRequestId;
    log.info(`node pairing required — entering wait loop (requestId=${requestId})`);
    this.pairingWait = { requestId, aborted: false };
    this.pairingStatusCallback?.(requestId);
    const deadline = Date.now() + PAIRING_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        if (this.pairingWait.aborted) throw new PairingCancelledError();
        await sleep(PAIRING_RETRY_MS); // oxlint-disable-line no-await-in-loop -- intentional sequential retry
        if (this.pairingWait.aborted) throw new PairingCancelledError();
        try {
          await this.openClient(opts); // oxlint-disable-line no-await-in-loop -- intentional sequential retry
          log.info(`node pairing approved (requestId=${requestId})`);
          return;
        } catch (err) {
          if (err instanceof GatewayPairingRequiredError) {
            if (err.requestId !== requestId) {
              log.info(`node pairing requestId rotated: ${requestId} → ${err.requestId}`);
              requestId = err.requestId;
              this.pairingWait.requestId = requestId;
              this.pairingStatusCallback?.(requestId);
            }
            continue;
          }
          throw err;
        }
      }
      throw new Error(
        `Node pairing timed out after ${Math.round(PAIRING_TIMEOUT_MS / 60_000)} minutes — try again`,
      );
    } finally {
      this.pairingWait = null;
    }
  }

  private async stopReconnect(): Promise<void> {
    this.setReconnectingState(false);
    if (this.reconnectLoopPromise) {
      await this.reconnectLoopPromise.catch(() => {});
      this.reconnectLoopPromise = null;
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnectLoopPromise) return this.reconnectLoopPromise;
    this.setReconnectingState(true);
    this.reconnectLoopPromise = this.runReconnectLoop().finally(() => {
      this.reconnectLoopPromise = null;
    });
    return this.reconnectLoopPromise;
  }

  private async runReconnectLoop(): Promise<void> {
    let delay = RECONNECT_INITIAL_MS;
    while (this.reconnecting) {
      log.info(`node reconnecting in ${delay}ms...`);
      await sleep(delay); // oxlint-disable-line no-await-in-loop -- intentional sequential retry
      if (!this.reconnecting) return;
      const opts = this.lastStartOpts;
      if (!opts) {
        log.warn("reconnect loop has no lastStartOpts — aborting");
        this.setReconnectingState(false);
        return;
      }
      try {
        this.ready = false;
        await this.openClient(opts); // oxlint-disable-line no-await-in-loop -- intentional sequential retry
        this.setReconnectingState(false);
        log.info("node reconnected");
        return;
      } catch (err) {
        if (err instanceof DeviceIdentityError) {
          if (!this.deviceIdentityFailedEmitted) {
            sendErrorTelemetry(makeAuthError(authErrors.GATEWAY_DEVICE_IDENTITY_FAILED));
            this.deviceIdentityFailedEmitted = true;
          }
          log.error("node non-recoverable device identity error:", err);
          this.setReconnectingState(false);
          return;
        }
        log.warn("node reconnect failed:", err);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      }
    }
  }
}
