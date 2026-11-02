import { randomUUID } from "crypto";

import type { ModelInfo, ReasoningEffort } from "../../../common/marshal-ipc-contract";
import { createLogger } from "../../../common/marshal-logger";
import type {
  BackendEvent,
  CreateSessionOpts,
  ExecutionCancelResult,
  ExecutionCapabilities,
  ExecutionEventEnvelope,
  ExecutionRunEnvelope,
  IExecutionBackend,
  ISessionBackend,
  McpOAuthLoginOptions,
  RemoteSessionEvent,
  RepositoryAgentDefinition,
  SendPayload,
  SessionHandle,
  SessionMessage,
  SessionMetadata,
  SkillProviderRoot,
  StoredSession,
  StartExecutionRunOptions,
  Unsubscribe,
} from "../types";
import { EXECUTION_ENVELOPE_VERSION, ExecutionConcurrencyLimitError } from "../types";
import {
  GATEWAY_SUPPORTED_MODEL_SUGGESTIONS,
  isGatewaySupportedModel,
  normalizeGatewayModelId,
} from "./model-id";
import { normalizeGatewayEvent, normalizeHistoryMessages } from "./normalize-event";
import {
  type GatewaySyncState,
  makeDeleteEvent,
  makeSnapshotEvent,
  makeUpsertEvent,
} from "./session-sync";
import type { GatewayExecutionProtocolCapabilities, IGatewayWsClient } from "./ws-client";

const log = createLogger("GatewayBackend");
const sessionLog = log.child("session");

interface GatewayRunRoute {
  envelope: ExecutionRunEnvelope;
  sessionKey: string;
  lastSequence?: number;
}

interface PendingGatewayRun {
  localRunId: string;
  sessionId: string;
  sessionKey: string;
  idempotencyKey: string;
  startedAtMs: number;
  clientEpoch: number;
  executionEpoch: number;
}

const MAX_RETAINED_RUNS = 1_000;
const LEGACY_EXECUTION_CAPABILITIES: GatewayExecutionProtocolCapabilities = {
  version: 0,
  maxConcurrentRuns: 1,
  runCorrelation: "legacy-single-run",
  cancellation: "runId",
  idempotency: "idempotencyKey",
  eventSequence: "transport-order",
  startAck: "unspecified",
};

// Gateway sessions run tools and load repository context in the remote runtime, so
// neither a host tool allowlist nor a project-context opt-out can be enforced here;
// refusing beats silently launching unrestricted.
function assertEnforceableSessionScope(opts: CreateSessionOpts): void {
  if (opts.allowedTools !== undefined) {
    throw new Error("Gateway sessions cannot enforce a host tool allowlist");
  }
  if (opts.projectContext === false) {
    throw new Error("Gateway sessions cannot exclude repository context");
  }
}

export class GatewaySessionBackend implements ISessionBackend, IExecutionBackend {
  private client: IGatewayWsClient | null = null;
  private clientEventUnsubscribe: Unsubscribe | null = null;
  private clientEpoch = 0;
  private executionEpoch = 0;
  private readonly subscribers = new Map<string, Set<(event: BackendEvent) => void>>();
  private readonly runSubscribers = new Map<string, Set<(event: ExecutionEventEnvelope) => void>>();
  /** Back-pointer to parent GatewayBackend for reconnect wiring. Set via
   *  attachBackendRef() during GatewayBackend.init() after the WS client is
   *  attached. Scoped to the narrow shape we need — we don't expose the
   *  whole GatewayBackend surface. */
  private backendRef: {
    setOnReconnected: (cb: (() => void) | null) => void;
    getOnReconnected?: () => (() => void) | null;
  } | null = null;
  private readonly routesByBackendRunId = new Map<string, GatewayRunRoute>();
  private readonly routesByLocalRunId = new Map<string, GatewayRunRoute>();
  private readonly pendingRuns = new Map<string, PendingGatewayRun>();
  private readonly cancelledPendingRuns = new Map<string, PendingGatewayRun>();
  private readonly inflightStarts = new Map<string, Promise<ExecutionRunEnvelope>>();
  private readonly activeLocalRunBySession = new Map<string, string>();
  private readonly endedRunIds = new Set<string>();
  private readonly completedRunsByLocalRunId = new Map<string, ExecutionRunEnvelope>();
  /** Consolidated sync state. `sessionKeys` and `localIdBySessionKey` track
   *  the routing token (sessionKey) used by outgoing RPCs; `backendIds`
   *  tracks the stable server-side identity (cloud sessionId) that is
   *  persisted as the row's backendId. See the map docstrings on
   *  `GatewaySyncState` for the directionality of each. */
  private readonly syncState: GatewaySyncState = {
    sessionKeys: new Map(),
    localIdBySessionKey: new Map(),
    backendIds: new Map(),
  };
  /** Throttle the resume()-time sessions.list reconcile to once per WS
   *  connection. Reset on clearSessionKeys() so sign-out forces a fresh one. */
  private listReconciled = false;
  /** Cached remote-events listener so refreshFromServer() can re-emit a
   *  snapshot event on demand (e.g. when cron fires and creates a session
   *  marshal doesn't broadcast via sessions.changed). Set inside
   *  subscribeToRemoteEvents; null before SessionManager wires the sidebar. */
  private remoteEventsListener: ((evt: RemoteSessionEvent) => void) | null = null;

  /** In-flight sessions.create promises keyed by Marshal sessionId. Two
   *  concurrent create() calls for the same id would both see an empty
   *  sessionKeys map at entry, each fire a server-side sessions.create, and
   *  end up with two cloud sessions for one logical chat. This dedupes them:
   *  the second caller awaits the first caller's promise. */
  private readonly inflightCreates = new Map<string, Promise<SessionHandle>>();

  /** Model requested at the time each in-flight create was started. Used only
   *  to warn when a second caller passes a different model — the dedupe will
   *  silently return the first caller's handle regardless. */
  private readonly inflightCreateModels = new Map<string, string>();
  private readonly desiredLabels = new Map<string, string>();
  private readonly appliedLabels = new Map<string, string>();
  private readonly labelPatchTails = new Map<string, Promise<void>>();

  listRepositoryAgents(_repoRoot: string): RepositoryAgentDefinition[] {
    // Gateway owns runtime-side repository customization discovery.
    return [];
  }

  getRepositoryAgentByPath(
    _repoRoot: string,
    _relativeAgentPath: string,
  ): RepositoryAgentDefinition | null {
    // Gateway owns runtime-side repository customization discovery.
    return null;
  }

  getRepositoryCustomizationsForSystemPrompt(
    _repoRoot?: string,
    _options?: { lean?: boolean },
  ): string {
    // Gateway constructs repository prompts on the remote runtime.
    return "";
  }

  getSkillProviderRoots(_repoRoot?: string): SkillProviderRoot[] {
    // Gateway owns runtime-side skill roots.
    return [];
  }

  /**
   * Attach a connected WebSocket client and wire up event broadcasting.
   * Called once from GatewayBackend.init() after the handshake completes.
   */
  attachClient(client: IGatewayWsClient): void {
    if (this.client && this.client !== client) {
      this.detachClient(this.client);
    } else {
      this.clientEventUnsubscribe?.();
    }
    this.client = client;
    const clientEpoch = ++this.clientEpoch;
    this.clientEventUnsubscribe = client.onEvent((eventName, payload) => {
      if (clientEpoch !== this.clientEpoch || this.client !== client) return;
      const runId = typeof payload["runId"] === "string" ? payload["runId"] : null;
      const sessionKey = typeof payload["sessionKey"] === "string" ? payload["sessionKey"] : null;

      if (runId && this.endedRunIds.has(runId)) {
        sessionLog.info(`drop ${eventName}: runId=${runId.slice(0, 8)} already ended`);
        return;
      }

      let route = runId ? this.routesByBackendRunId.get(runId) : undefined;
      if (!route && runId && this.getGatewayExecutionCapabilities().version === 0) {
        route = this.bindLegacyPendingRun(runId, sessionKey);
      }
      if (route && sessionKey && route.sessionKey !== sessionKey) {
        sessionLog.warn(`drop ${eventName}: runId=${runId?.slice(0, 8)} sessionKey mismatch`);
        return;
      }

      const targetSessionId =
        route?.envelope.sessionId ??
        (sessionKey ? (this.syncState.localIdBySessionKey.get(sessionKey) ?? null) : null);
      if (!targetSessionId) {
        const runIdTag = runId ? runId.slice(0, 8) : "(none)";
        const reason = !sessionKey
          ? "no run route or sessionKey"
          : "no sessionKey reverse-lookup hit";
        const detail =
          eventName === "agent"
            ? ` stream=${typeof payload["stream"] === "string" ? payload["stream"] : "?"} dataKeys=[${
                payload["data"] !== null && typeof payload["data"] === "object"
                  ? Object.keys(payload["data"]).join(",")
                  : "(no data)"
              }]`
            : "";
        sessionLog.info(`drop ${eventName} runId=${runIdTag}: ${reason}${detail}`);
        return;
      }
      if (!route && this.activeLocalRunBySession.has(targetSessionId)) {
        sessionLog.warn(
          `drop ${eventName}: ${runId ? `unknown runId=${runId.slice(0, 8)}` : "missing runId"} for session with a tracked run`,
        );
        return;
      }

      const sequence = route ? this.readSequence(route, payload) : undefined;
      if (sequence === null) {
        sessionLog.warn(
          `drop ${eventName}: runId=${route?.envelope.backendRunId.slice(0, 8)} violated sequence contract`,
        );
        return;
      }

      const events = normalizeGatewayEvent(eventName, payload);
      if (events.length === 0) {
        const rawData = payload["data"];
        const dataKeys =
          rawData !== null && typeof rawData === "object"
            ? Object.keys(rawData).join(",")
            : "(no data)";
        const detail =
          eventName === "agent"
            ? `stream=${typeof payload["stream"] === "string" ? payload["stream"] : "?"} dataKeys=[${dataKeys}]`
            : eventName === "chat"
              ? // Keys only — the runtime could one day echo user prompt text
                // into errorMessage and we don't want that on disk.
                `state=${typeof payload["state"] === "string" ? payload["state"] : "?"} hasMessage=${"message" in payload} hasErrorMessage=${"errorMessage" in payload}`
              : `keys=[${Object.keys(payload).join(",")}]`;
        sessionLog.info(`drop ${eventName}: normalizer returned no events (${detail})`);
        return;
      }

      const targetListeners = this.subscribers.get(targetSessionId);
      const runListeners = route ? this.runSubscribers.get(route.envelope.localRunId) : undefined;
      sessionLog.info(
        `accept ${eventName}: runId=${runId ? runId.slice(0, 8) : "(none)"} sessionId=${targetSessionId} subscribers=${targetListeners?.size ?? 0} normalizedTypes=[${events.map((e) => e.type).join(",")}]`,
      );

      if (!targetListeners && !runListeners) {
        sessionLog.info(`drop ${eventName}: no subscribers for targetSessionId=${targetSessionId}`);
      }

      for (const event of events) {
        if (targetListeners) {
          for (const listener of targetListeners) {
            try {
              listener(event);
            } catch (err) {
              sessionLog.warn("Subscriber threw:", err);
            }
          }
        }
        if (route && runListeners) {
          const envelope: ExecutionEventEnvelope = {
            version: EXECUTION_ENVELOPE_VERSION,
            localRunId: route.envelope.localRunId,
            backendRunId: route.envelope.backendRunId,
            sessionId: route.envelope.sessionId,
            ...(sequence === undefined ? {} : { sequence }),
            event,
          };
          for (const listener of runListeners) {
            try {
              listener(envelope);
            } catch (err) {
              sessionLog.warn("Run subscriber threw:", err);
            }
          }
        }
      }

      if (
        route &&
        events.some(
          (event) =>
            event.type === "idle" || (event.type === "turn-error" && event.retrying !== true),
        )
      ) {
        this.completeRoute(route);
      }
    });
  }

  /** @internal */ detachClient(client?: IGatewayWsClient): void {
    if (client && this.client !== client) return;
    const detachedClientEpoch = this.clientEpoch;
    this.clientEventUnsubscribe?.();
    this.clientEventUnsubscribe = null;
    this.client = null;
    this.clientEpoch += 1;
    for (const pending of this.pendingRuns.values()) {
      if (pending.clientEpoch !== detachedClientEpoch) continue;
      this.pendingRuns.delete(pending.localRunId);
      this.inflightStarts.delete(pending.localRunId);
      if (
        !this.routesByLocalRunId.has(pending.localRunId) &&
        this.activeLocalRunBySession.get(pending.sessionId) === pending.localRunId
      ) {
        this.activeLocalRunBySession.delete(pending.sessionId);
      }
    }
  }

  async create(opts: CreateSessionOpts): Promise<SessionHandle> {
    assertEnforceableSessionScope(opts);
    if (!this.client) {
      throw new Error("GatewayBackend: not connected — call init() first");
    }
    opts.assertWorkspaceCurrent?.();
    // Substitute non-Anthropic models. The gateway routes Claude through
    // marshal → Anthropic; gpt-* / gemini-* aren't on this path and would
    // produce silent "LLM request timed out" failures downstream. We could
    // throw `GatewayUnsupportedModelError` here, but that surfaces a hard
    // error during a routine UX flow ("user selected the Gateway runtime, default
    // was a gpt model"). Instead, substitute to the first
    // suggestion and warn — ModelManager.getDefaultModel already filters
    // unsupported saved defaults, so this branch only fires for genuine
    // direct callers (programmatic session create, stale sessionData on
    // disk). Done before the fast-path return so a prior run's unsupported
    // model isn't carried forward.
    if (opts.model && !isGatewaySupportedModel(opts.model)) {
      const substitute = GATEWAY_SUPPORTED_MODEL_SUGGESTIONS[0];
      log.warn(
        `Model "${opts.model}" is not supported on the Marshal gateway — substituting "${substitute}" for session ${opts.sessionId}.`,
      );
      opts = { ...opts, model: substitute };
    }
    // Fast-path idempotence: if we already have a sessionKey, a cloud session
    // exists — return the cached handle. `existingBackendId` may be absent if
    // the session was seeded via remote reconcile (local id === cloud id); in
    // that case fall back to the local sessionId which equals the backendId.
    const existingKey = this.syncState.sessionKeys.get(opts.sessionId);
    if (existingKey) {
      await this.applyDesiredLabel(opts.sessionId, existingKey).catch((error: unknown) => {
        log.warn(`create(${opts.sessionId}): failed to apply desired label:`, error);
      });
      return {
        sessionId: opts.sessionId,
        backendId: this.syncState.backendIds.get(opts.sessionId) ?? opts.sessionId,
      };
    }
    // Concurrency-safe idempotence: if a create is already in-flight for this
    // sessionId, await its promise. Two concurrent SessionManager paths
    // (prewarm, switchSession, refreshSession) firing create() in the same
    // tick would both see an empty map above and each fire their own
    // sessions.create RPC — ending up with two cloud sessions for one logical
    // chat. This Map<sessionId, Promise> wins that race.
    const inflight = this.inflightCreates.get(opts.sessionId);
    if (inflight) {
      if (opts.model && opts.model !== this.inflightCreateModels.get(opts.sessionId)) {
        log.warn(
          `create(${opts.sessionId}): awaiting in-flight create with model="${this.inflightCreateModels.get(opts.sessionId)}"; requested model="${opts.model}" will be ignored`,
        );
      }
      return inflight;
    }
    const client = this.client;
    this.inflightCreateModels.set(opts.sessionId, opts.model ?? "");
    const promise = (async (): Promise<SessionHandle> => {
      let res: { key: string; sessionId: string };
      try {
        opts.assertWorkspaceCurrent?.();
        res = await client.sessionsCreate({
          label: opts.sessionId,
          // Translate legacy dotted Anthropic ids ("claude-opus-4.7") to the
          // canonical hyphenated form the gateway/marshal adapter expects on
          // the wire. Disk + Copilot path keep the dotted form unchanged —
          // see gateway-model-id.ts for why.
          model: normalizeGatewayModelId(opts.model),
        });
      } catch (err) {
        // Lobster rejects duplicate labels; Aether tolerated them. Reconcile
        // via sessions.list (matched by label) and reuse the existing row.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/label already in use/i.test(msg)) throw err;
        log.info(
          `create(${opts.sessionId}): label collision on Lobster — reconciling via sessions.list`,
        );
        let list: Awaited<ReturnType<typeof client.sessionsList>>;
        try {
          list = await client.sessionsList({ limit: 500 });
        } catch (listErr) {
          log.warn(
            `create(${opts.sessionId}): sessions.list reconcile failed after label collision:`,
            listErr instanceof Error ? listErr.message : String(listErr),
          );
          throw err;
        }
        const row = list.sessions.find((s) => s.label === opts.sessionId);
        const reconciledKey = typeof row?.key === "string" ? row.key : "";
        const reconciledBackendId = typeof row?.sessionId === "string" ? row.sessionId : "";
        if (!reconciledKey || !reconciledBackendId) throw err;
        res = { key: reconciledKey, sessionId: reconciledBackendId };
      }
      this.syncState.sessionKeys.set(opts.sessionId, res.key);
      this.syncState.localIdBySessionKey.set(res.key, opts.sessionId);
      this.syncState.backendIds.set(opts.sessionId, res.sessionId);
      await this.applyDesiredLabel(opts.sessionId, res.key).catch((error: unknown) => {
        log.warn(`create(${opts.sessionId}): failed to apply desired label:`, error);
      });
      return {
        sessionId: opts.sessionId,
        backendId: res.sessionId,
      };
    })().finally(() => {
      this.inflightCreates.delete(opts.sessionId);
      this.inflightCreateModels.delete(opts.sessionId);
    });
    this.inflightCreates.set(opts.sessionId, promise);
    return promise;
  }

  async resume(sessionId: string, opts: CreateSessionOpts): Promise<SessionHandle> {
    assertEnforceableSessionScope(opts);
    opts.assertWorkspaceCurrent?.();
    // Gateway sessions are durable on cloud; no session.resume RPC — they
    // never go away server-side until sessions.delete. Resume just rehydrates
    // the in-memory routing state so subsequent send()/destroy() work.
    let key = this.syncState.sessionKeys.get(sessionId);

    // Process-restart hydration. After the first sign-in of a fresh process,
    // syncState is empty — but the session row still exists in the cloud
    // (durable until sessions.delete). list() seeds routing keys keyed by
    // `backendId` for every paired-device session in one shot; we then
    // mirror under the local sessionId so subsequent send() / history()
    // lookups hit the cache. `listReconciled` throttles to one reconcile
    // per WS connection — clearSessionKeys() resets it so a sign-out forces
    // a fresh reconcile, and a second resume() with a different sessionId
    // can still mirror from the already-seeded `backendId` entry.
    if (!key && opts.backendId) {
      if (this.client && !this.listReconciled) {
        try {
          // Reconcile syncState from the gateway. makeSnapshotEvent seeds
          // sessionKeys/backendIds keyed by backendId as a side effect — same
          // routing-table population the removed public list() did, just
          // without returning SessionMetadata.
          const res = await this.client.sessionsList({ limit: 500 });
          makeSnapshotEvent(res, this.syncState);
          this.listReconciled = true;
        } catch (err) {
          log.warn(
            `resume: sessions.list reconcile failed for ${sessionId}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      const hydrated = this.syncState.sessionKeys.get(opts.backendId);
      if (hydrated) {
        this.syncState.sessionKeys.set(sessionId, hydrated);
        this.syncState.localIdBySessionKey.set(hydrated, sessionId);
        key = hydrated;
      }
    }

    if (!key) {
      throw new Error(
        `GatewayBackend.resume: no sessionKey for ${sessionId} — call create() first or wait for reconcile`,
      );
    }
    const backendId = opts.backendId ?? this.syncState.backendIds.get(sessionId) ?? sessionId;
    this.syncState.backendIds.set(sessionId, backendId);
    return {
      sessionId,
      backendId,
    };
  }

  async compact(_sessionId: string): Promise<void> {
    throw new Error("Provider does not support session compaction.");
  }

  async destroy(sessionId: string): Promise<void> {
    const key = this.syncState.sessionKeys.get(sessionId);
    // No sessionKey for this session (e.g. session from disk never resumed in
    // this run, or key cleared by sign-out). Treat as a best-effort local
    // delete — the caller (SessionManager.deleteSession) still cleans up its
    // on-disk row, which is the user's intent. A stale cloud-side session is
    // acceptable: it stays out of subsequent sessions.list responses only if
    // cloud also knows it's gone, but the cost of leaving it is a phantom row
    // rather than a UX block.
    if (!key) {
      this.dropExecutionForSession(sessionId);
      log.warn(
        `destroy: no sessionKey for ${sessionId} — skipping cloud RPC, local delete proceeds`,
      );
      return;
    }
    if (!this.client) {
      // Client gone (mid-reconnect / signed out). Same reasoning: don't block
      // the local delete. Drop the entry so we don't try again on retry.
      this.forgetSession(sessionId, key);
      this.dropExecutionForSession(sessionId);
      log.warn(`destroy: client disconnected — skipping cloud RPC for ${sessionId}`);
      return;
    }
    await this.client.sessionsDelete({ key, deleteTranscript: true });
    // Only clear the maps after cloud confirms — if the RPC throws, keep the
    // entries so the caller can retry with the same mapping.
    this.forgetSession(sessionId, key);
    this.dropExecutionForSession(sessionId);
  }

  /** Drop every in-memory trace of a session across all three sync maps.
   *  Centralized so destroy() and the live sessions.changed delete handler
   *  stay consistent — forgetting to clear backendIds here would leak map
   *  entries indefinitely until sign-out. */
  private forgetSession(sessionId: string, keyHint?: string): void {
    const key = keyHint ?? this.syncState.sessionKeys.get(sessionId);
    this.syncState.sessionKeys.delete(sessionId);
    if (key) this.syncState.localIdBySessionKey.delete(key);
    this.syncState.backendIds.delete(sessionId);
    this.appliedLabels.delete(sessionId);
    this.labelPatchTails.delete(sessionId);
  }

  getCapabilities(): ExecutionCapabilities {
    const capability = this.getGatewayExecutionCapabilities();
    return {
      version: EXECUTION_ENVELOPE_VERSION,
      maxConcurrentRuns: capability.maxConcurrentRuns,
      concurrency: capability.version === 1 ? "negotiated" : "legacy-single-run",
      correlation: "backend-run-id",
      cancellation: "exact-run",
      idempotency: "wire-key",
      eventSequence: capability.eventSequence === "seq" ? "monotonic" : "transport-order",
    };
  }

  async startRun(
    sessionId: string,
    payload: SendPayload,
    options: StartExecutionRunOptions = {},
  ): Promise<ExecutionRunEnvelope> {
    if (!this.client) {
      throw new Error("GatewayBackend: not connected — call init() first");
    }

    const localRunId = options.localRunId ?? randomUUID();
    const existing =
      this.routesByLocalRunId.get(localRunId)?.envelope ??
      this.completedRunsByLocalRunId.get(localRunId);
    if (existing) {
      if (existing.sessionId !== sessionId) {
        throw new Error(
          `GatewayBackend.startRun: localRunId ${localRunId} belongs to another session`,
        );
      }
      return existing;
    }
    const pendingRun = this.pendingRuns.get(localRunId);
    if (pendingRun && pendingRun.sessionId !== sessionId) {
      throw new Error(
        `GatewayBackend.startRun: localRunId ${localRunId} belongs to another session`,
      );
    }
    const inflight = this.inflightStarts.get(localRunId);
    if (inflight) return inflight;

    const sessionKey = this.syncState.sessionKeys.get(sessionId);
    if (!sessionKey) {
      throw new Error(
        `GatewayBackend.startRun: no sessionKey for ${sessionId} — create()/resume() must run first`,
      );
    }

    if (this.activeLocalRunBySession.has(sessionId)) {
      throw new ExecutionConcurrencyLimitError(1, 1);
    }
    const capability = this.getGatewayExecutionCapabilities();
    if (this.activeLocalRunBySession.size >= capability.maxConcurrentRuns) {
      throw new ExecutionConcurrencyLimitError(
        this.activeLocalRunBySession.size,
        capability.maxConcurrentRuns,
      );
    }

    const pending: PendingGatewayRun = {
      localRunId,
      sessionId,
      sessionKey,
      idempotencyKey: options.idempotencyKey ?? localRunId,
      startedAtMs: Date.now(),
      clientEpoch: this.clientEpoch,
      executionEpoch: this.executionEpoch,
    };
    this.pendingRuns.set(localRunId, pending);
    this.activeLocalRunBySession.set(sessionId, localRunId);

    const client = this.client;
    const promise = client
      .chatSend({
        message: payload.prompt,
        sessionKey,
        idempotencyKey: pending.idempotencyKey,
      })
      .then(
        ({ runId }) => {
          if (this.cancelledPendingRuns.get(localRunId) === pending) {
            this.cancelledPendingRuns.delete(localRunId);
            this.rememberEndedRunId(runId);
            void client
              .chatAbort({ sessionKey, runId })
              .catch((err: unknown) =>
                log.warn(`late chat.abort failed (fire-and-forget): ${String(err)}`),
              );
            throw new Error(
              `GatewayBackend.startRun: ${localRunId} was cancelled before acknowledgement`,
            );
          }
          if (
            pending.clientEpoch !== this.clientEpoch ||
            pending.executionEpoch !== this.executionEpoch ||
            this.pendingRuns.get(localRunId) !== pending
          ) {
            const currentRun =
              this.routesByLocalRunId.get(localRunId)?.envelope ??
              this.completedRunsByLocalRunId.get(localRunId);
            if (currentRun?.backendRunId !== runId) {
              this.rememberEndedRunId(runId);
            }
            throw new Error(
              `GatewayBackend.startRun: runtime changed before ${localRunId} was acknowledged`,
            );
          }
          const route = this.routesByLocalRunId.get(localRunId);
          if (route) {
            if (route.envelope.backendRunId !== runId) {
              this.abandonRoute(route);
              this.rememberEndedRunId(runId);
              throw new Error(
                `GatewayBackend.startRun: chat.send acknowledged ${runId} after events bound ${route.envelope.backendRunId}`,
              );
            }
            return route.envelope;
          }
          const completed = this.completedRunsByLocalRunId.get(localRunId);
          if (completed) {
            if (completed.backendRunId !== runId) {
              if (this.completedRunsByLocalRunId.get(localRunId) === completed) {
                this.completedRunsByLocalRunId.delete(localRunId);
              }
              this.rememberEndedRunId(runId);
              throw new Error(
                `GatewayBackend.startRun: chat.send acknowledged ${runId} after completed run ${completed.backendRunId}`,
              );
            }
            return completed;
          }
          return this.bindPendingRun(pending, runId).envelope;
        },
        (error: unknown) => {
          if (
            this.pendingRuns.get(localRunId) === pending &&
            pending.clientEpoch === this.clientEpoch &&
            pending.executionEpoch === this.executionEpoch
          ) {
            const accepted =
              this.routesByLocalRunId.get(localRunId)?.envelope ??
              this.completedRunsByLocalRunId.get(localRunId);
            if (accepted) return accepted;
          }
          throw error;
        },
      )
      .finally(() => {
        if (this.cancelledPendingRuns.get(localRunId) === pending) {
          this.cancelledPendingRuns.delete(localRunId);
        }
        if (this.inflightStarts.get(localRunId) === promise) {
          this.inflightStarts.delete(localRunId);
        }
        if (this.pendingRuns.get(localRunId) === pending) {
          this.pendingRuns.delete(localRunId);
          if (
            !this.routesByLocalRunId.has(localRunId) &&
            this.activeLocalRunBySession.get(sessionId) === localRunId
          ) {
            this.activeLocalRunBySession.delete(sessionId);
          }
        }
      });
    this.inflightStarts.set(localRunId, promise);
    sessionLog.info(
      `startRun: localRunId=${localRunId.slice(0, 8)} sessionId=${sessionId} sessionKey=${sessionKey.slice(0, 8)} promptLen=${payload.prompt.length}`,
    );
    return promise;
  }

  async cancelRun(localRunId: string): Promise<ExecutionCancelResult> {
    const route = this.routesByLocalRunId.get(localRunId);
    if (!route) {
      const pending = this.pendingRuns.get(localRunId);
      if (!pending) return { localRunId, cancelled: false };
      this.pendingRuns.delete(localRunId);
      this.cancelledPendingRuns.set(localRunId, pending);
      if (this.activeLocalRunBySession.get(pending.sessionId) === localRunId) {
        this.activeLocalRunBySession.delete(pending.sessionId);
      }
      this.runSubscribers.delete(localRunId);
      return { localRunId, cancelled: true };
    }
    if (!route || !this.client) return { localRunId, cancelled: false };

    this.completeRoute(route);
    const result = await this.client.chatAbort({
      sessionKey: route.sessionKey,
      runId: route.envelope.backendRunId,
    });
    if (!result.ok) {
      throw new Error(`Gateway did not acknowledge cancellation for ${localRunId}`);
    }
    return { localRunId, cancelled: true };
  }

  subscribeRun(localRunId: string, listener: (event: ExecutionEventEnvelope) => void): Unsubscribe {
    let listeners = this.runSubscribers.get(localRunId);
    if (!listeners) {
      listeners = new Set();
      this.runSubscribers.set(localRunId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.runSubscribers.delete(localRunId);
    };
  }

  private getGatewayExecutionCapabilities(): GatewayExecutionProtocolCapabilities {
    return this.client?.getExecutionCapabilities?.() ?? LEGACY_EXECUTION_CAPABILITIES;
  }

  private bindLegacyPendingRun(
    backendRunId: string,
    sessionKey: string | null,
  ): GatewayRunRoute | undefined {
    if (this.pendingRuns.size !== 1) return undefined;
    const pending = this.pendingRuns.values().next().value;
    if (
      !pending ||
      pending.clientEpoch !== this.clientEpoch ||
      pending.executionEpoch !== this.executionEpoch ||
      (sessionKey && pending.sessionKey !== sessionKey)
    ) {
      return undefined;
    }
    return this.bindPendingRun(pending, backendRunId);
  }

  private bindPendingRun(pending: PendingGatewayRun, backendRunId: string): GatewayRunRoute {
    const existing = this.routesByBackendRunId.get(backendRunId);
    if (existing) {
      if (existing.envelope.localRunId !== pending.localRunId) {
        throw new Error(`GatewayBackend.startRun: backend runId ${backendRunId} is already routed`);
      }
      return existing;
    }
    if (this.endedRunIds.has(backendRunId)) {
      throw new Error(`GatewayBackend.startRun: backend runId ${backendRunId} already ended`);
    }
    const envelope: ExecutionRunEnvelope = {
      version: EXECUTION_ENVELOPE_VERSION,
      localRunId: pending.localRunId,
      backendRunId,
      sessionId: pending.sessionId,
      idempotencyKey: pending.idempotencyKey,
      startedAtMs: pending.startedAtMs,
    };
    const route: GatewayRunRoute = { envelope, sessionKey: pending.sessionKey };
    this.routesByBackendRunId.set(backendRunId, route);
    this.routesByLocalRunId.set(pending.localRunId, route);
    return route;
  }

  private readSequence(
    route: GatewayRunRoute,
    payload: Record<string, unknown>,
  ): number | undefined | null {
    if (this.getGatewayExecutionCapabilities().eventSequence !== "seq") return undefined;
    const sequence = payload["seq"];
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
      return null;
    }
    if (route.lastSequence !== undefined && sequence <= route.lastSequence) return null;
    route.lastSequence = sequence;
    return sequence;
  }

  private completeRoute(route: GatewayRunRoute): void {
    if (!this.removeRoute(route)) return;
    this.completedRunsByLocalRunId.set(route.envelope.localRunId, route.envelope);
    while (this.completedRunsByLocalRunId.size > MAX_RETAINED_RUNS) {
      const oldest = this.completedRunsByLocalRunId.keys().next().value;
      if (oldest) this.completedRunsByLocalRunId.delete(oldest);
    }
  }

  private abandonRoute(route: GatewayRunRoute): void {
    this.removeRoute(route);
  }

  private removeRoute(route: GatewayRunRoute): boolean {
    const { backendRunId, localRunId, sessionId } = route.envelope;
    if (this.routesByBackendRunId.get(backendRunId) !== route) return false;
    this.routesByBackendRunId.delete(backendRunId);
    this.routesByLocalRunId.delete(localRunId);
    if (this.activeLocalRunBySession.get(sessionId) === localRunId) {
      this.activeLocalRunBySession.delete(sessionId);
    }
    this.rememberEndedRunId(backendRunId);
    this.runSubscribers.delete(localRunId);
    return true;
  }

  private rememberEndedRunId(backendRunId: string): void {
    this.endedRunIds.add(backendRunId);
    while (this.endedRunIds.size > MAX_RETAINED_RUNS) {
      const oldest = this.endedRunIds.values().next().value;
      if (oldest) this.endedRunIds.delete(oldest);
    }
  }

  private dropExecutionForSession(sessionId: string): void {
    const localRunId = this.activeLocalRunBySession.get(sessionId);
    if (!localRunId) return;
    this.pendingRuns.delete(localRunId);
    this.inflightStarts.delete(localRunId);
    const route = this.routesByLocalRunId.get(localRunId);
    if (route) this.abandonRoute(route);
    if (this.activeLocalRunBySession.get(sessionId) === localRunId) {
      this.activeLocalRunBySession.delete(sessionId);
    }
    this.runSubscribers.delete(localRunId);
  }

  async send(
    sessionId: string,
    payload: SendPayload,
    options?: StartExecutionRunOptions,
  ): Promise<void> {
    await this.startRun(sessionId, payload, options);
  }

  async abort(sessionId: string): Promise<{ invalidatedSessionIds?: string[] }> {
    const localRunId = this.activeLocalRunBySession.get(sessionId);
    if (localRunId) await this.cancelRun(localRunId);
    return {};
  }

  async initiateMcpOAuth(
    _sessionId: string,
    _serverName: string,
    _options?: McpOAuthLoginOptions,
  ): Promise<{ authorizationUrl?: string }> {
    // Gateway Phase 1 does not host local SDK MCP sessions, so local MCP OAuth is unavailable.
    throw new Error("MCP sign-in is not available in this mode.");
  }

  subscribe(sessionId: string, listener: (event: BackendEvent) => void): Unsubscribe {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    // oxlint-disable-next-line @typescript-eslint/no-non-null-assertion -- just set above
    this.subscribers.get(sessionId)!.add(listener);
    return () => {
      this.subscribers.get(sessionId)?.delete(listener);
    };
  }

  clearSessionKeys(): void {
    this.syncState.sessionKeys.clear();
    this.syncState.localIdBySessionKey.clear();
    this.syncState.backendIds.clear();
    this.desiredLabels.clear();
    this.appliedLabels.clear();
    this.labelPatchTails.clear();
    this.clearExecutionState();
    this.listReconciled = false;
  }

  /** @internal */ clearExecutionState(): void {
    this.executionEpoch += 1;
    this.routesByBackendRunId.clear();
    this.routesByLocalRunId.clear();
    this.pendingRuns.clear();
    this.cancelledPendingRuns.clear();
    this.inflightStarts.clear();
    this.activeLocalRunBySession.clear();
    this.runSubscribers.clear();
    this.endedRunIds.clear();
    this.completedRunsByLocalRunId.clear();
  }

  async setModel(
    _sessionId: string,
    _model: string,
    _options?: { reasoningEffort?: ReasoningEffort },
  ): Promise<void> {
    // No-op in Phase 1 — model selection not supported by gateway MVP.
  }

  async getHistory(id: string): Promise<SessionMessage[]> {
    if (!this.client) {
      throw new Error("GatewayBackend: not connected — call init() first");
    }
    const key = this.syncState.sessionKeys.get(id);
    if (!key) {
      throw new Error(`GatewayBackend.getHistory: no sessionKey for ${id}`);
    }
    const res = await this.client.chatHistory({ sessionKey: key, limit: 200 });
    return normalizeHistoryMessages(res.messages);
  }

  async exportConversationState(
    _sessionId: string,
  ): Promise<import("../../../common/runtime-conversation-state").RuntimeConversationState | null> {
    // Gateway history is paginated UI history, not an export of retained model context.
    return null;
  }

  async defaultModelForRuntime(
    _target: import("../../../common/runtime-accounts").RuntimeTarget,
  ): Promise<string> {
    // Gateway cannot host clients of other runtimes or local runtime accounts.
    throw new Error("Gateway cannot launch an agent on a local runtime.");
  }

  async listModelsForRuntime(
    _target: import("../../../common/runtime-accounts").RuntimeTarget,
  ): Promise<ModelInfo[]> {
    // Gateway cannot host clients of other runtimes, so it has no peer catalogs to list.
    return [];
  }

  async fetchSessionData(indexEntry: SessionMetadata): Promise<StoredSession | null> {
    try {
      const messages = await this.getHistory(indexEntry.id);
      return { ...indexEntry, messages };
    } catch (err) {
      log.warn(`fetchSessionData: getHistory failed for ${indexEntry.id}:`, err);
      return null;
    }
  }

  activeSessionCount(): number {
    // Gateway has no local session pool.
    return 0;
  }

  activeSessionIds(): string[] {
    // Gateway has no local session pool.
    return [];
  }

  async disconnect(sessionId: string): Promise<void> {
    const key = this.syncState.sessionKeys.get(sessionId);
    this.dropExecutionForSession(sessionId);
    this.forgetSession(sessionId, key);
    this.subscribers.delete(sessionId);
    this.listReconciled = false;
  }

  async patchLabel(sessionId: string, label: string): Promise<void> {
    if (this.appliedLabels.get(sessionId) === label) return;
    this.desiredLabels.set(sessionId, label);
    this.appliedLabels.delete(sessionId);
    if (!this.client) return;
    const previous = this.labelPatchTails.get(sessionId)?.catch(() => undefined);
    // oxlint-disable-next-line eslint/prefer-const -- assigned after promise construction so cleanup closes over the canonical tail
    let patch!: Promise<void>;
    patch = (previous ?? Promise.resolve())
      .then(async () => {
        const inflight = this.inflightCreates.get(sessionId);
        if (inflight) await inflight;
        await this.applyDesiredLabel(sessionId);
      })
      .finally(() => {
        if (this.labelPatchTails.get(sessionId) === patch) {
          this.labelPatchTails.delete(sessionId);
        }
      });
    this.labelPatchTails.set(sessionId, patch);
    return patch;
  }

  private async applyDesiredLabel(sessionId: string, keyOverride?: string): Promise<void> {
    const client = this.client;
    const label = this.desiredLabels.get(sessionId);
    const key = keyOverride ?? this.syncState.sessionKeys.get(sessionId);
    if (!client || !label || !key || this.appliedLabels.get(sessionId) === label) return;
    await client.sessionsPatch({ key, label });
    if (this.desiredLabels.get(sessionId) === label) {
      this.appliedLabels.set(sessionId, label);
      this.desiredLabels.delete(sessionId);
    }
  }

  async subscribeToSessionsChanged(
    onChange: (evt: {
      reason: "create" | "patch" | "delete" | "compact" | "reset";
      sessionKey: string;
      session?: Record<string, unknown>;
    }) => void,
  ): Promise<() => void> {
    if (!this.client) {
      throw new Error("GatewayBackend: not connected — call init() first");
    }
    return this.client.sessionsSubscribe(onChange);
  }

  /**
   * Deliver a single event to every subscriber on every session. Used by
   * GatewayBackend for connection-level signals (reconnecting status,
   * turn-error on connection loss) that aren't scoped to one chat.
   */
  broadcastToAll(event: BackendEvent): void {
    for (const listeners of this.subscribers.values()) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          sessionLog.warn("Subscriber threw:", err);
        }
      }
    }
  }

  /** Wire up the back-reference to the parent GatewayBackend so
   *  subscribeToRemoteEvents can hook the reconnect callback.
   *  Called once from GatewayBackend.init() after attachClient. */
  attachBackendRef(ref: {
    setOnReconnected: (cb: (() => void) | null) => void;
    getOnReconnected?: () => (() => void) | null;
  }): void {
    this.backendRef = ref;
  }

  async subscribeToRemoteEvents(listener: (evt: RemoteSessionEvent) => void): Promise<() => void> {
    log.info(`subscribeToRemoteEvents called, client=${this.client ? "attached" : "null"}`);
    if (!this.client) return () => {};

    this.remoteEventsListener = listener;

    const snapshot = async (): Promise<void> => {
      if (!this.client) return;
      const res = await this.client.sessionsList({ limit: 500 });
      const evt = makeSnapshotEvent(res, this.syncState);
      if (evt) listener(evt);
    };

    await snapshot();

    const unsubChanges = await this.client.sessionsSubscribe((rawEvt) => {
      if (rawEvt.reason === "delete") {
        const evt = makeDeleteEvent(rawEvt, this.syncState);
        if (evt) {
          listener(evt);
        } else {
          log.warn(
            `sessions.changed delete without resolvable backendId (key=${rawEvt.sessionKey})`,
          );
        }
        return;
      }
      const evt = makeUpsertEvent(rawEvt, this.syncState);
      if (evt) listener(evt);
    });

    // Re-prime snapshot on reconnect. setOnReconnected is single-slot, so
    // capture our own callback locally and only null it out on unsub if the
    // slot still holds ours. Prevents a later subscription's callback from
    // being wiped if it raced a prior unsub.
    const onReconnected = (): void => void snapshot();
    this.backendRef?.setOnReconnected(onReconnected);

    return () => {
      unsubChanges();
      this.remoteEventsListener = null;
      const ref = this.backendRef;
      if (ref && ref.getOnReconnected?.() === onReconnected) {
        ref.setOnReconnected(null);
      }
    };
  }

  /** Force a fresh sessions.list and emit a snapshot event to the currently
   *  registered remote-events listener. Invoked by GatewayBackend when the
   *  `cron` event fires — marshal persists cron-born sessions without
   *  broadcasting sessions.changed, so without this the sidebar misses them. */
  async refreshFromServer(): Promise<void> {
    if (!this.client) {
      if (process.env.DEBUG_GATEWAY_SYNC === "1") log.info("refreshFromServer skipped: no client");
      return;
    }
    if (!this.remoteEventsListener) {
      if (process.env.DEBUG_GATEWAY_SYNC === "1") {
        log.info(
          "refreshFromServer skipped: no listener registered (SessionManager hasn't subscribed yet)",
        );
      }
      return;
    }
    const res = await this.client.sessionsList({ limit: 500 });
    const evt = makeSnapshotEvent(res, this.syncState);
    if (evt) {
      if (process.env.DEBUG_GATEWAY_SYNC === "1") {
        log.info(`refreshFromServer emitting snapshot with ${res.sessions?.length ?? 0} sessions`);
      }
      this.remoteEventsListener(evt);
    }
  }

  async applyConfigChange(sessionId: string, _recreate: () => Promise<void>): Promise<void> {
    // Local config toggles (disabled MCPs, file chooser, skills) aren't synced
    // to the gateway yet — the pushConfig() slice will cover this in a future
    // task. Critically we must NOT call recreate(): destroying the cloud session
    // and creating a new one would leak the existing session, split the runId
    // stream, and mean in-flight agent events land on the wrong session handle.
    log.warn(
      `applyConfigChange(${sessionId}) skipped: local config changes (skills / MCP / file-chooser) are not yet synced to cloud — see pushConfig spec`,
    );
  }

  async notifyRenamed(sessionId: string, newName: string): Promise<void> {
    if (!this.client) return;
    // Phase 1 bridge: delegate to existing patchLabel method.
    // Task 10 inlines this logic during the consolidation pass.
    return this.patchLabel(sessionId, newName);
  }
}
