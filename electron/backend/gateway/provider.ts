/**
 * GatewayBackend — IBackendProvider implementation for the Marshal gateway.
 *
 * Phase 1 MVP: only sessions.send() actually communicates with the gateway.
 * All automation and tool operations are stubbed. Auth is based on WebSocket
 * connection state rather than a separate auth flow.
 */

import type {
  GatewayAuthIdentity,
  MSettings,
  PairedDevice,
  PendingDeviceRequest,
} from "../../../common/marshal-ipc-contract";
import { GATEWAY_AUTH_MODES } from "../../../common/marshal-ipc-contract";
import { createLogger } from "../../../common/marshal-logger";
import { GATEWAY_RUNTIME_ID } from "../../../common/runtime-config";
import { authErrors, makeAuthError } from "../../../common/telemetry/errors/marshal-auth";
import type { HostedRuntimeProvider } from "../../hosted-runtime/contracts";
import { resolveHostedRuntimeProvider } from "../../hosted-runtime/current";
import { getSelfTools, type SelfToolDeps } from "../../self-tools";
import { sendErrorTelemetry } from "../../telemetry-errors";
import type { MarshalPromptFiles } from "../ports";
import type {
  ApprovalCallback,
  AttachDesktopCapabilitiesDeps,
  AttachmentRef,
  AttachmentUpload,
  AuthMachineryDeps,
  AuthMachineryHandle,
  AuthStatus,
  BackendCapabilities,
  CustomMcpServer,
  IAutomationBackend,
  IAutomationManager,
  IBackendProvider,
  IHeartbeatManager,
  IPermissionPolicyProvider,
  IPermissionsBackend,
  ISelfToolDeps,
  ISessionBackend,
  ITenantPolicyProvider,
  IToolBackend,
  InferOpts,
  LoginResult,
  RuntimeConfigPayload,
} from "../types";
import { createGatewayAuthController } from "./auth/controller";
import { createFileStoreAdapter } from "./auth/file-store-adapter";
import { registerGatewayAuthHandlers } from "./auth/handlers";
import { GatewayAutomationBackend } from "./automation/backend";
import {
  ConditionSupervisor,
  parseCronIdFromParentSessionKey,
  type IConditionSupervisor,
} from "./automation/condition-supervisor";
import { GatewayAutomationOrchestrator } from "./automation/orchestrator";
import { DeviceIdentityError, readDeviceIdentity, type DeviceIdentity } from "./device-identity";
import { isLoopbackGatewayEndpoint } from "./network/local-endpoint";
import {
  GatewayNodeSubsystem,
  type IpcHandlerDeps,
  type GatewayNodeSubsystemDeps,
} from "./node-subsystem";
import { GatewayPermissionsBackend } from "./permissions/backend";
import { GatewaySessionBackend } from "./session";
import { GatewayToolBackend } from "./tools";
import type { IGatewayWsClient } from "./ws-client";
import { GatewayPairingRequiredError, GatewayWsClient } from "./ws-client";

/**
 * Gateway-only deps for DesktopCapabilities — kept as a re-export of the
 * polymorphic `AttachDesktopCapabilitiesDeps` from `types.ts`. The deps
 * arrive via `IToolBackend.attachDesktopCapabilities` (called from main.ts
 * symmetrically for both backends); copilot is a no-op while gateway
 * constructs the desktop.* RPC bridge. When unset, the bridge is not
 * constructed at init() time and `desktop.*` RPCs surface as
 * `not-supported` from the WS dispatcher's default-case branch.
 */
export type GatewayDesktopCapabilitiesDeps = AttachDesktopCapabilitiesDeps;

const log = createLogger("GatewayBackend");

export interface GatewayBackendConfig {
  /** URL for no-auth mode — typically a local dev runtime. */
  gatewayUrl: string; // ws://localhost:8001/v1/marshal-gateway
  /** URL for hosted mode, from MARSHAL_HOSTED_GATEWAY_URL. Empty when no hosted gateway is configured. */
  hostedGatewayUrl: string; // wss://…/v1/marshal-gateway
  deviceIdentityPath: string; // path to adapter identity JSON
  gatewayToken: string; // shared handshake token
  /** Provider that owns the hosted runtime's endpoint, auth token and device
   *  trust. Defaults to the configured hosted runtime when omitted. */
  hostedRuntime?: HostedRuntimeProvider;
  // authToken removed — pass the credential to login() instead
}

/**
 * Per-init arguments handed to a `WsClientFactory`. Mirrors the inline
 * constructor call site so the production factory is a one-liner.
 */
export interface WsClientFactoryArgs {
  url: string;
  gatewayToken: string;
  deviceIdentity: DeviceIdentity;
  authToken?: string;
}

export type WsClientFactory = (args: WsClientFactoryArgs) => IGatewayWsClient;

const defaultWsClientFactory: WsClientFactory = (args) => new GatewayWsClient(args);

const PAIRING_RETRY_MS = 5_000;
/** Matches Marshal's 5-min pending-request TTL — once the runtime expires
 *  the request server-side our retries fail with NOT_FOUND anyway. */
const PAIRING_TIMEOUT_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { PairingCancelledError } from "./auth/pairing-cancelled-error";
import { PairingCancelledError } from "./auth/pairing-cancelled-error";
import { isRecord } from "./record-guard";

function isAuthMode(s: string): s is GatewayAuthIdentity["mode"] {
  return (GATEWAY_AUTH_MODES as ReadonlyArray<string>).includes(s);
}

// Drops malformed entries rather than throwing so unknown future optional
// fields don't break the panel.
function isPendingDeviceRequest(
  v: unknown,
): v is { requestId: string; deviceId: string } & Record<string, unknown> {
  return (
    isRecord(v) &&
    typeof v.requestId === "string" &&
    typeof v.deviceId === "string" &&
    typeof v.ts === "number"
  );
}

function isPairedDevice(
  v: unknown,
): v is { deviceId: string; approvedAtMs: number } & Record<string, unknown> {
  return isRecord(v) && typeof v.deviceId === "string" && typeof v.approvedAtMs === "number";
}

function normalizePending(
  v: { requestId: string; deviceId: string } & Record<string, unknown>,
): PendingDeviceRequest {
  const out: PendingDeviceRequest = {
    requestId: v.requestId,
    deviceId: v.deviceId,
    ts: typeof v.ts === "number" ? v.ts : 0,
  };
  if (typeof v.displayName === "string") out.displayName = v.displayName;
  if (typeof v.platform === "string") out.platform = v.platform;
  if (typeof v.role === "string") out.role = v.role;
  if (Array.isArray(v.scopes) && v.scopes.every((s) => typeof s === "string")) {
    out.scopes = v.scopes;
  }
  return out;
}

function normalizePaired(
  v: { deviceId: string; approvedAtMs: number } & Record<string, unknown>,
): PairedDevice {
  const out: PairedDevice = {
    deviceId: v.deviceId,
    approvedAtMs: v.approvedAtMs,
  };
  if (typeof v.displayName === "string") out.displayName = v.displayName;
  if (typeof v.role === "string") out.role = v.role;
  if (typeof v.lastSeenAtMs === "number") out.lastSeenAtMs = v.lastSeenAtMs;
  return out;
}

/** Boundary check on `IBackendProvider.login()`'s untyped credentials bag —
 *  rejects unknown modes before they reach buildAuthToken. */
function toGatewayAuthIdentity(credentials: unknown): GatewayAuthIdentity {
  if (!isRecord(credentials)) {
    throw new Error("GatewayBackend.login: credentials must be an object");
  }
  const mode = credentials["mode"];
  if (typeof mode !== "string" || !isAuthMode(mode)) {
    throw new Error(`GatewayBackend.login: unknown auth mode "${String(mode)}"`);
  }
  // roleMode + nodeName are intentionally dropped here — the node subsystem
  // reads them from the typed cred kept by GatewayAuthController. Callers
  // MUST route through GatewayAuthController.signIn if they need roleMode /
  // nodeName to be honored; direct backend.login() will silently lose them.
  const cred: GatewayAuthIdentity = { mode };
  if (typeof credentials["oid"] === "string") cred.oid = credentials["oid"];
  if (typeof credentials["tid"] === "string") cred.tid = credentials["tid"];
  return cred;
}

export class GatewayBackend implements IBackendProvider {
  readonly runtimeId = GATEWAY_RUNTIME_ID;
  readonly origin = "gateway" as const;
  private readonly config: GatewayBackendConfig;
  private readonly node: GatewayNodeSubsystem | null;
  private client: IGatewayWsClient | null = null;
  private ready = false;
  private reconnecting = false;
  /** Set by login / signOut while they tear down the current client, so the
   *  onStateChange("disconnected") listener doesn't spuriously kick off
   *  reconnect() during an intentional close. Distinct from `reconnecting`
   *  because the reconnect loop itself uses that flag to avoid self-retrigger. */
  private intentionalClose = false;
  /** Tracks whether GATEWAY_DEVICE_IDENTITY_FAILED has been emitted for this
   * backend instance. Device identity failures are persistent — the file
   * stays corrupted across every reconnect attempt — so without this guard a
   * single user would emit one event per reconnect tick for the lifetime of
   * the session. Cleared only when the instance is reconstructed. */
  private deviceIdentityFailedEmitted = false;
  /** Handle on the in-flight reconnect loop so login / signOut can await it
   *  before replacing `client` — prevents two concurrent inits. */
  private reconnectLoopPromise: Promise<void> | null = null;
  /** Token from the most recent signInAs, passed through on reconnect so the
   *  authenticated identity survives a dropped connection. */
  private lastAuthToken: string | undefined = undefined;
  /** Consumer-supplied callback fired after runReconnectLoop successfully
   *  re-opens the WS and re-runs init(). Used by SessionManager to re-send
   *  sessions.subscribe on the new socket — otherwise the live sidebar feed
   *  silently dies after the first network blip. */
  private onReconnectedCallback: (() => void) | null = null;
  /** Cached device identity — the file is immutable at runtime, so parsing it
   *  once avoids readFileSync + JSON.parse + createPrivateKey on every
   *  reconnect (which happens every 1-30s under exponential backoff). */
  private cachedDeviceIdentity: DeviceIdentity | null = null;
  /** URL the next init() / reconnect should dial. Defaults to the local URL;
   *  login(cred) flips this to the AAD URL when cred.mode === "hosted" so the
   *  reconnect loop also targets the right host. */
  private currentUrl: string;
  /** Active Marshal pairing-wait. Holds the requestId the user is waiting
   *  to be approved + an abort flag toggled by cancelPairing(). Null when no
   *  pairing wait is in flight. */
  private pairingWait: { requestId: string; aborted: boolean } | null = null;
  /** Optional callback invoked when login() enters the pairing-wait loop —
   *  the controller wires this to push status: "pairing" to the renderer. */
  private pairingStatusCallback: ((requestId: string) => void) | null = null;
  /** Optional callback invoked when ``this.reconnecting`` transitions
   *  true ↔ false. main.ts uses this to surface a "Reconnecting…" banner
   *  via the auth controller's ``setReconnecting`` hook. Strictly
   *  edge-triggered: idempotent assignments don't re-fire it. */
  private reconnectingChangeCallback: ((reconnecting: boolean) => void) | null = null;
  private readonly wsClientFactory: WsClientFactory;
  private readonly _sessions: GatewaySessionBackend;
  private readonly _automation: GatewayAutomationBackend;
  private readonly _tools: GatewayToolBackend;
  private readonly _permissions: GatewayPermissionsBackend;
  private readonly _orchestrator = new GatewayAutomationOrchestrator();
  private _conditionSupervisor: IConditionSupervisor;
  /** Unsubscribe handle for the cron→session-refresh piggy-back listener. */
  private cronSessionUnsub: (() => void) | null = null;
  private automationsChangedUnsub: (() => void) | null = null;
  private automationsChangedCallback: (() => void) | null = null;

  // ── DesktopCapabilities (Phase 2b-2) ────────────────────────────────────────
  // The bridge + impl + deps now live on `GatewayToolBackend` (gained via
  // `IToolBackend.attachDesktopCapabilities`); main.ts wires both backends
  // through the same polymorphic method. Self-tools are pushed in via
  // `setSelfToolDeps()` and forwarded to the tool backend's resolver.
  /** Local self-tool registry deps, set via `setSelfToolDeps()`. The
   *  `executeLocalTool` self-tool path resolves these lazily so the capability
   *  composition can be constructed before SessionManager pushes deps in. */
  private selfToolDepsRaw: SelfToolDeps | null = null;

  constructor(
    config: GatewayBackendConfig,
    nodeDeps?: GatewayNodeSubsystemDeps,
    wsClientFactory: WsClientFactory = defaultWsClientFactory,
  ) {
    this.config = config;
    this.node = nodeDeps ? new GatewayNodeSubsystem(nodeDeps) : null;
    this.currentUrl = config.gatewayUrl;
    this.wsClientFactory = wsClientFactory;
    this._sessions = new GatewaySessionBackend();
    this._automation = new GatewayAutomationBackend({
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    this._tools = new GatewayToolBackend();
    this._permissions = new GatewayPermissionsBackend();
    this._conditionSupervisor = new ConditionSupervisor({
      cronRemove: ({ id }) => {
        if (!this.client) {
          return Promise.reject(new Error("ConditionSupervisor: no client attached"));
        }
        return this.client.request("cron.remove", { id });
      },
    });
    this._automation.attachConditionSupervisor(this._conditionSupervisor);
    // Bridge self-tool deps from SessionManager (which calls
    // setSelfToolDeps on us) into the tool backend's lazy resolver so
    // executeLocalTool can resolve self-tools at the moment of dispatch.
    // The local filesystem tools (getSelfFsTools) are intentionally NOT
    // included here: they operate on the local machine's filesystem, which is
    // meaningful for the local Copilot backend but not the remote marshal
    // runtime — the Gateway model uses the remote runtime's own file access.
    this._tools.setSelfToolsResolver(
      (sessionId) =>
        this.selfToolDepsRaw?.sessionManager.getExclusiveSessionTools(sessionId) ??
        (this.selfToolDepsRaw
          ? getSelfTools({ ...this.selfToolDepsRaw, currentSessionId: sessionId })
          : null),
    );
  }

  get sessions(): ISessionBackend {
    return this._sessions;
  }

  get execution(): GatewaySessionBackend {
    return this._sessions;
  }

  get automation(): IAutomationBackend {
    return this._automation;
  }

  get tools(): IToolBackend {
    return this._tools;
  }

  get permissions(): IPermissionsBackend {
    return this._permissions;
  }

  loadWorkspaceFiles(): MarshalPromptFiles | null {
    // Gateway/marshal owns cloud workspace prompt construction; desktop should
    // not inject local Workspace 1.0 defaults on this backend.
    return null;
  }

  async init(opts?: { authToken?: string }): Promise<void> {
    log.info(
      `init() called, already-ready=${this.ready} url=${this.currentUrl} authToken=${opts?.authToken ? "present" : "absent"}`,
    );
    if (this.ready) return;

    // Tear down any stale client before creating the new one. Without this,
    // the reconnect loop leaks the old client's onEvent + onStateChange
    // listeners (each reconnect adds a new listener to whatever still holds a
    // reference to the old client object).
    if (this.client) {
      this.client.close();
      this.client = null;
    }

    if (!this.cachedDeviceIdentity) {
      this.cachedDeviceIdentity = readDeviceIdentity(this.config.deviceIdentityPath);
    }
    const deviceIdentity = this.cachedDeviceIdentity;

    const client = this.wsClientFactory({
      url: this.currentUrl,
      gatewayToken: this.config.gatewayToken,
      deviceIdentity,
      authToken: opts?.authToken,
    });

    // Subscribe to connection state changes for observability and reconnection.
    client.onStateChange((state) => {
      if (state === "disconnected") {
        if (this.client && this.client !== client) return;
        this._sessions.detachClient(client);
        // Skip the reconnect trigger when login / signOut / destroy is
        // intentionally closing this client — otherwise the close() synchronous
        // state-change would race with the caller's own re-init.
        if (this.intentionalClose) return;

        // Emit turn-error to all active subscribers so UI shows connection lost
        this._sessions.broadcastToAll({
          type: "turn-error",
          error: "Gateway connection lost",
          recoverable: true,
        });

        if (!this.reconnecting) {
          this.reconnect().catch((err) => log.error("Reconnect loop failed:", err));
        }
      }
    });

    await client.connect();

    this.client = client;

    // Wire the client into the session backend and attach event broadcasting.
    this._sessions.attachClient(client);
    this._sessions.attachBackendRef(this);
    this._tools.attachClient(client);
    this._automation.attachClient(client);
    this._permissions.attachClient(client);

    // Attach the orchestrator to manage multi-step chain progression.
    this._orchestrator.attachClient(client);

    // Cron-session visibility: marshal's cron path persists named-target
    // sessions (session:auto-<id>) to the session store but doesn't emit
    // sessions.changed. Piggy-back on the `cron` lifecycle event to force a
    // session-list refresh so automation runs appear in the sidebar.
    // Attached here (not in subscribeToRemoteEvents) so it survives any timing
    // gap between client attach and the SessionManager's initClient call.
    // If a prior init() attached a listener to an older client (reconnect path:
    // runReconnectLoop sets `ready = false` and calls init again), release the
    // stale handle before reassigning. The underlying client's listeners Set
    // is already empty after `client.close()`, but keeping the state honest
    // here prevents leaks if the close/reattach order ever changes.
    if (this.cronSessionUnsub) {
      this.cronSessionUnsub();
      this.cronSessionUnsub = null;
    }
    this.cronSessionUnsub = client.onEvent((eventName, payload) => {
      if (eventName === "cron") {
        if (process.env.DEBUG_GATEWAY_SYNC === "1") {
          log.info("cron event observed — forcing session-list refresh");
        }
        void this._sessions.refreshFromServer();
        if (isRecord(payload)) {
          const action = typeof payload.action === "string" ? payload.action : "";
          const jobId = typeof payload.jobId === "string" ? payload.jobId : undefined;
          if (action) {
            this._automation.handleCronEvent({ action, jobId });
          }
        }
      } else if (eventName === "sessions.changed") {
        // Belt-and-braces: owner-side cron.remove on observed cron-run spawn,
        // in case the watcher's agent forgets cron.remove(self).
        if (!isRecord(payload)) return;
        const reason = typeof payload.reason === "string" ? payload.reason : "";
        if (reason !== "create") return;
        const session = isRecord(payload.session) ? payload.session : null;
        if (!session) return;
        const parentSessionKey =
          typeof session.parentSessionKey === "string" ? session.parentSessionKey : undefined;
        const cronId = parseCronIdFromParentSessionKey(parentSessionKey);
        if (!cronId) return;
        void this._conditionSupervisor.handleSpawnFromCron(cronId);
      }
    });
    log.info("cron event listener attached for automation session visibility");

    // Reconcile any chains that were missed while desktop was offline.
    void this._orchestrator.reconcile().catch((err) => {
      log.warn({ err }, "orchestrator reconcile failed at init");
    });

    void this._automation.reconcileConditionAutomations().catch((err) => {
      log.warn({ err }, "condition-automation reconcile failed at init");
    });

    // Re-subscribe across reconnects (init runs on every reconnect attempt).
    if (this.automationsChangedUnsub) {
      this.automationsChangedUnsub();
      this.automationsChangedUnsub = null;
    }
    this.automationsChangedUnsub = this._automation.onAutomationsChanged((automation) => {
      log.info(
        `Automation ${automation.id} changed (firedAt=${automation.firedAt ?? "none"}); broadcasting refresh`,
      );
      this.automationsChangedCallback?.();
    });

    // The desktop.* RPC bridge attaches via the tool backend's
    // `attachClient` (the call above), which itself runs the
    // `attachDesktopCapabilitiesBridge` if `attachDesktopCapabilities` deps
    // were already supplied by main.ts. No additional wiring needed here.

    this.ready = true;
    log.info("init() complete, ready=true");
  }

  async destroy(): Promise<void> {
    await this.stopReconnect();
    this.intentionalClose = true;
    try {
      this._sessions.clearSessionKeys();
      this._sessions.detachClient();
      this._tools.detachClient();
      this._automation.detachClient();
      this._permissions.detachClient();
      this._orchestrator.detachClient();
      if (this.cronSessionUnsub) {
        this.cronSessionUnsub();
        this.cronSessionUnsub = null;
      }
      if (this.automationsChangedUnsub) {
        this.automationsChangedUnsub();
        this.automationsChangedUnsub = null;
      }
      this.ready = false;
      if (this.client) {
        this.client.close();
        this.client = null;
      }
    } finally {
      this.intentionalClose = false;
    }
  }

  /**
   * Cancel any in-flight reconnect loop and wait for it to settle.
   * Callers that replace `this.client` (signInAs, signOut, destroy) must await
   * this before tearing down so the loop doesn't establish an orphaned client
   * after we've already moved on.
   */
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
    let delay = 1000;
    const maxDelay = 30_000;

    while (this.reconnecting) {
      // oxlint-disable-line no-await-in-loop -- intentionally sequential: retry loop with exponential backoff
      log.info(`Reconnecting in ${delay}ms...`);

      // Emit status to UI
      this._sessions.broadcastToAll({ type: "status", text: "Reconnecting..." });

      await new Promise((resolve) => setTimeout(resolve, delay)); // oxlint-disable-line no-await-in-loop -- intentional sequential delay
      // Re-check after the sleep — signOut / signInAs may have set reconnecting
      // to false while we were waiting, and we must not establish a new
      // connection after the caller has moved on.
      if (!this.reconnecting) return;

      try {
        this.ready = false;
        // Pass the last-used auth token so the reconnected session keeps the
        // same identity — otherwise the WS handshake runs anonymously and the
        // gateway routes us to the wrong (or rejected) container.
        await this.init({ authToken: this.lastAuthToken }); // oxlint-disable-line no-await-in-loop -- intentional sequential retry
        this.setReconnectingState(false);
        // Clear status
        this._sessions.broadcastToAll({ type: "status", text: null });
        log.info("Reconnected successfully");
        // Notify consumers (SessionManager) so they can re-establish
        // server-push subscriptions on the new socket. Without this,
        // sessions.subscribe stays bound to the previous (closed) client
        // and live sidebar updates stop firing after the first WS blip.
        if (this.onReconnectedCallback) {
          try {
            this.onReconnectedCallback();
          } catch (cbErr) {
            log.warn("onReconnected callback threw:", cbErr);
          }
        }
        return;
      } catch (err) {
        // Non-recoverable: corrupted identity file / invalid PEM / malformed
        // JSON. Retrying will produce the same failure forever — stop the
        // loop and surface a terminal turn-error so the UI can tell the user
        // to regenerate the file instead of silently spinning.
        if (err instanceof DeviceIdentityError) {
          if (!this.deviceIdentityFailedEmitted) {
            sendErrorTelemetry(makeAuthError(authErrors.GATEWAY_DEVICE_IDENTITY_FAILED));
            this.deviceIdentityFailedEmitted = true;
          }
          log.error("Non-recoverable device identity error:", err);
          this.setReconnectingState(false);
          this._sessions.broadcastToAll({
            type: "turn-error",
            error: `Device identity error: ${err.message}`,
            recoverable: false,
          });
          return;
        }
        log.warn("Reconnect failed:", err);
        delay = Math.min(delay * 2, maxDelay);
      }
    }
  }

  /** Register a callback fired after successful reconnect (post-init). Only
   *  one callback is supported; a second call replaces the first. Used by
   *  SessionManager to re-send sessions.subscribe on the new socket. */
  setOnReconnected(callback: (() => void) | null): void {
    this.onReconnectedCallback = callback;
  }

  /** Inspect the currently-registered reconnect callback. Subscribers use
   *  this to guard against a stale unsub clobbering a newer subscription's
   *  callback: only null the slot if it still holds the one we registered. */
  getOnReconnected(): (() => void) | null {
    return this.onReconnectedCallback;
  }

  setOnAutomationsChangedBroadcaster(fn: (() => void) | null): void {
    this.automationsChangedCallback = fn;
  }

  /** Replace the watcher supervisor wired into both the sessions.changed
   *  listener and the automation backend. Test seam — production code creates
   *  the supervisor in the constructor and never swaps it. */
  attachConditionSupervisor(supervisor: IConditionSupervisor): void {
    this._conditionSupervisor = supervisor;
    this._automation.attachConditionSupervisor(supervisor);
  }

  isReady(): boolean {
    return this.ready && (this.client?.isConnected() ?? false);
  }

  capabilities(): BackendCapabilities {
    return {
      taskList: false,
      cronExpressions: false,
      retryPolicy: false,
      policyEditor: false,
      heartbeatIsolated: false,
      modelFallback: false,
      connectionStatus: true,
      sessionCompaction: false,
      busyTurnSteer: false,
      automations: {
        multiStep: true, // Phase 2b-1 — orchestrator handles step-as-cron
        workingDir: false,
        skills: false,
        perAutomationPermissions: false,
        conditionTrigger: true,
        heartbeat: true, // Phase 3a-1: now connected via marshal config.* RPCs
        heartbeatRunNow: false, // Phase 3a-1: marshal doesn't expose runNow RPC yet
        bundleImport: false,
        exportImport: false,
        githubImport: false,
      },
      // Phase 2b-2: scaffolding lands now; each flag flips to `true` in a small
      // follow-up m PR after lobster confirms its runtime invokes the matching
      // RPC during cron-fired runs. Spec §5.6.
      desktopCapabilities: {
        localTools: false,
        notifications: false,
      },
    };
  }

  async infer(_opts: InferOpts): Promise<string> {
    // Marshal exposes no stateless one-shot inference endpoint (neither WS
    // RPC nor HTTP) as of 2026-04-20. SessionManager.generateTitle() catches
    // this throw and falls back to the local makeQuickTitle heuristic, which
    // we then sync to cloud via sessions.patch { label }. See the gateway
    // session surface spec, "Out of scope > infer()", for the follow-up plan.
    //
    // Intentionally NOT instrumented with INFER_FAILED telemetry: the throw
    // is invariant under gateway mode (every infer call hits it), so emitting
    // would flood local telemetry with a constant baseline equal to "gateway sessions ×
    // features that call infer". The signal we care about — real Copilot
    // backend timeouts — would be drowned out. CopilotBackend.infer is the
    // only emit site.
    throw new Error("GatewayBackend: infer() not supported — gateway has no one-shot endpoint");
  }

  async uploadAttachment(_file: AttachmentUpload): Promise<AttachmentRef> {
    // TODO(gateway-p2): upload to the gateway's object store and return the
    // resulting AttachmentRef. The UI disables the attach affordance while the
    // gateway backend is active, so this path isn't reachable in Phase 1.
    throw new Error("GatewayBackend: attachments not supported in Phase 1");
  }

  async pushConfig(_config: RuntimeConfigPayload): Promise<void> {
    // No-op — gateway receives config via other channels in Phase 2.
  }

  async checkAuthStatus(): Promise<AuthStatus> {
    return { authenticated: this.client?.isConnected() ?? false };
  }

  /** No-op when called without credentials (satisfies the IBackendProvider
   *  contract for backend-agnostic callers); otherwise drives the chosen mode
   *  through buildAuthToken and re-inits against the per-mode URL. */
  async login(credentials?: unknown): Promise<LoginResult> {
    if (!credentials) return {};
    const cred = toGatewayAuthIdentity(credentials);
    if (cred.mode === "hosted" && !this.config.hostedGatewayUrl) {
      throw new Error(
        "No hosted gateway is configured. Set MARSHAL_HOSTED_GATEWAY_URL to the gateway's wss:// URL.",
      );
    }
    this.currentUrl =
      cred.mode === "hosted" ? this.config.hostedGatewayUrl : this.config.gatewayUrl;
    await this.stopReconnect();
    this._sessions.clearExecutionState();
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
    const authToken = await this.buildAuthToken(cred);
    this.lastAuthToken = authToken;
    try {
      await this.init({ authToken });
    } catch (err) {
      if (err instanceof GatewayPairingRequiredError) {
        await this.runPairingLoop(err.requestId, authToken);
      } else {
        throw err;
      }
    }
    return {};
  }

  setPairingStatusCallback(callback: ((requestId: string) => void) | null): void {
    this.pairingStatusCallback = callback;
  }

  setReconnectingChangeCallback(callback: ((reconnecting: boolean) => void) | null): void {
    this.reconnectingChangeCallback = callback;
  }

  async renameNode(nodeId: string, displayName: string): Promise<void> {
    if (!this.client) throw new Error("operator socket not connected");
    await this.client.request("node.rename", { nodeId, displayName });
  }

  /** Edge-triggered helper around the ``reconnecting`` flag. Fires the
   *  registered callback only on real transitions so a self-assignment
   *  (e.g. the explicit ``= false`` after success that's already false)
   *  doesn't churn the UI. */
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

  cancelPairing(): void {
    if (this.pairingWait) {
      this.pairingWait.aborted = true;
    }
  }

  // Anchors the "local mode" decision on the URL we'd dial next, so the IPC
  // handler and the renderer panel agree on "local" via a single field.
  isLocalGateway(): boolean {
    return isLoopbackGatewayEndpoint(this.currentUrl);
  }

  async listPendingDevices(): Promise<{
    pending: PendingDeviceRequest[];
    paired: PairedDevice[];
  }> {
    if (!this.client) {
      throw new Error("GatewayBackend.listPendingDevices: not connected");
    }
    const raw = (await this.client.request("device.pair.list", {})) as Record<string, unknown>; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- RPC response narrowed below
    const pending = Array.isArray(raw.pending) ? raw.pending : [];
    const paired = Array.isArray(raw.paired) ? raw.paired : [];
    return {
      pending: pending.flatMap((p) => (isPendingDeviceRequest(p) ? [normalizePending(p)] : [])),
      paired: paired.flatMap((p) => (isPairedDevice(p) ? [normalizePaired(p)] : [])),
    };
  }

  async approveDevice(requestId: string): Promise<void> {
    if (!this.client) {
      throw new Error("GatewayBackend.approveDevice: not connected");
    }
    await this.client.request("device.pair.approve", { requestId });
  }

  /** Retry connect until the operator approves, the request TTL elapses, or
   *  cancelPairing() flips the abort flag. Only `GatewayPairingRequiredError`
   *  is caught — other errors surface so users see real connection failures. */
  private async runPairingLoop(requestId: string, authToken: string | undefined): Promise<void> {
    log.info(`pairing required — entering wait loop (requestId=${requestId})`);
    this.pairingWait = { requestId, aborted: false };
    this.pairingStatusCallback?.(requestId);
    const deadline = Date.now() + PAIRING_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        if (this.pairingWait.aborted) {
          throw new PairingCancelledError();
        }
        await sleep(PAIRING_RETRY_MS); // oxlint-disable-line no-await-in-loop -- intentional sequential retry
        if (this.pairingWait.aborted) {
          throw new PairingCancelledError();
        }
        try {
          await this.init({ authToken }); // oxlint-disable-line no-await-in-loop -- intentional sequential retry
          log.info(`pairing approved — connect succeeded (requestId=${requestId})`);
          return;
        } catch (err) {
          if (err instanceof GatewayPairingRequiredError) {
            // Still pending — keep waiting. Track id changes defensively in
            // case the gateway re-creates the request after expiry.
            if (err.requestId !== requestId) {
              log.info(`pairing requestId rotated: ${requestId} → ${err.requestId}`);
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
        `Pairing timed out after ${Math.round(PAIRING_TIMEOUT_MS / 60_000)} minutes — try again`,
      );
    } finally {
      this.pairingWait = null;
    }
  }

  private async buildAuthToken(cred: GatewayAuthIdentity): Promise<string | undefined> {
    if (cred.mode === "no-auth") return undefined;
    if (cred.mode === "hosted") {
      const hostedRuntime = this.config.hostedRuntime ?? resolveHostedRuntimeProvider();
      return hostedRuntime.acquireAuthToken();
    }
    const _exhaustive: never = cred.mode;
    return _exhaustive;
  }

  async signOut(): Promise<void> {
    this.cancelPairing();
    await this.stopReconnect();
    this.intentionalClose = true;
    try {
      this._sessions.clearSessionKeys();
      this._sessions.detachClient();
      this._tools.detachClient();
      this._automation.detachClient();
      this._permissions.detachClient();
      this._orchestrator.detachClient();
      if (this.cronSessionUnsub) {
        this.cronSessionUnsub();
        this.cronSessionUnsub = null;
      }
      if (this.automationsChangedUnsub) {
        this.automationsChangedUnsub();
        this.automationsChangedUnsub = null;
      }
      this.lastAuthToken = undefined;
      if (this.client) {
        this.client.close();
        this.client = null;
      }
      this.ready = false;
    } finally {
      this.intentionalClose = false;
    }
  }

  setApprovalCallback(_callback: ApprovalCallback): void {
    // No-op — gateway handles approvals server-side in Phase 2.
  }

  setHeartbeatManager(_hm: IHeartbeatManager): void {
    // No-op (Rule 3): gateway heartbeat state lives in marshal; the local
    // HeartbeatManager only exists in copilot mode.
  }

  setSettingsManager(_sm: { get(): MSettings; update(patch: Partial<MSettings>): void }): void {
    // No-op (Rule 3): gateway permissions are stored in marshal's config;
    // CopilotPermissionsBackend is copilot-mode-only.
  }

  setAutomationManager(_am: IAutomationManager): void {
    // No-op (Rule 3): gateway automations are stored in marshal's cron
    // table; no local AutomationManager to wire.
  }

  setRunActivitySubscriber(_subscriber: (listener: () => void) => () => void): void {
    // No-op — cron fires server-side; no in-process run to heartbeat.
  }

  setPermissionPolicy(_policy: IPermissionPolicyProvider): void {
    // No-op — permission policy is server-side for gateway.
  }

  setCustomMcpServers(_servers: CustomMcpServer[]): void {
    // No-op — MCP servers managed server-side.
  }

  setInterceptFileChooser(_enabled: boolean): void {
    // No-op.
  }

  setSelfToolDeps(deps: ISelfToolDeps): void {
    // After the self-tool ports refactor `SelfToolDeps = ISelfToolDeps` — same shape,
    // no cast needed. Local field stays typed as `SelfToolDeps` to keep the
    // intent ("the bag of self-tool ports") readable at the call site.
    this.selfToolDepsRaw = deps;
  }

  setTimezoneProvider(_fn: () => string): void {
    // No-op (Rule 3): no gateway-side tool reads the desktop timezone.
  }

  setTenantPolicyProvider(_provider: ITenantPolicyProvider): void {
    // No-op (Rule 3): tenant policy for gateway is enforced server-side in marshal;
    // browser egress config is not generated for gateway sessions.
  }

  async restart(): Promise<void> {
    await this.destroy();
  }

  async forceKill(): Promise<void> {
    this.setReconnectingState(false);
    this._sessions.clearExecutionState();
    this._sessions.detachClient();
    // Tear down per-client wiring on the tool backend (approval router +
    // desktop bridge) before closing the socket. Deps survive — a sign-back-in
    // (or restart) re-runs init() which calls _tools.attachClient(newClient).
    this._tools.detachClient();
    this._permissions.detachClient();
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    this.ready = false;
  }

  isHealthy(): boolean {
    return this.client?.isConnected() ?? false;
  }

  attachAuthMachinery(deps: AuthMachineryDeps): AuthMachineryHandle {
    const node = this.node;
    const wrappedOnSignOut = async (): Promise<void> => {
      try {
        await deps.onSignOut?.();
      } catch (err) {
        log.warn("onSignOut hook threw:", err);
      }
      try {
        await node?.stop();
      } catch (err) {
        log.warn("node-side stop failed:", err);
      }
    };
    const wrappedOnSignedIn = async (identity: GatewayAuthIdentity): Promise<void> => {
      try {
        await deps.onSignedIn?.(identity);
      } catch (err) {
        log.warn("onSignedIn hook threw:", err);
      }
      try {
        await node?.start(identity, this);
      } catch (err) {
        log.warn("node-side start failed:", err);
      }
    };

    const controller = createGatewayAuthController({
      backend: this,
      store: createFileStoreAdapter(),
      broadcaster: deps.sendStateChange,
      onSignOut: wrappedOnSignOut,
      onSignedIn: wrappedOnSignedIn,
    });
    registerGatewayAuthHandlers({ ipcHandle: deps.ipcHandle }, controller);

    let operatorReconnecting = false;
    let nodeReconnecting = false;
    const refresh = (): void => {
      controller.setReconnecting(operatorReconnecting || nodeReconnecting);
    };
    this.setReconnectingChangeCallback((value) => {
      operatorReconnecting = value;
      refresh();
    });
    node?.setReconnectingChangeCallback((value) => {
      nodeReconnecting = value;
      refresh();
    });

    return {
      getState: () => controller.getState(),
      tryAutoSignIn: () => controller.tryAutoSignIn(),
      setReconnecting: (reconnecting) => controller.setReconnecting(reconnecting),
    };
  }

  registerNodeIpcHandlers(deps: IpcHandlerDeps): void {
    this.node?.registerIpcHandlers(deps);
  }

  async dispose(): Promise<void> {
    await this.node?.dispose();
  }
}
