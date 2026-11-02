import { fileURLToPath } from "node:url";
import * as os from "os";
import * as path from "path";

import { app } from "electron";

import { isAuthError } from "../../../common/foundation/auth/auth-errors";
import { APP_NAME } from "../../../common/marshal-constants";
import type {
  IpcEventMap,
  IpcHandler,
  IpcInvokeMap,
  MSettings,
} from "../../../common/marshal-ipc-contract";
import { applyDefaultRuntimeAccount } from "../../../common/model-runtime-routing";
import { normalizeRuntimeAccounts } from "../../../common/runtime-accounts";
import { makeSessionError, sessionErrors } from "../../../common/telemetry/errors/marshal-session";
import { getAppDataDir } from "../../app-paths";
import type { AppMcpBrokerManager } from "../../mcp-broker-manager";
import { buildMcpConfig } from "../../mcp-tools";
import { secureMkdirSync, secureWriteFileSync } from "../../platform-security";
import { buildPlaywrightEgressConfig } from "../../platform/browser-egress-config";
import { sendErrorTelemetry } from "../../telemetry-errors";
import { getActiveWorkspaceRoot } from "../../workspace-store";
import type { MarshalPromptFiles } from "../ports";
import type { RuntimeMcpServerConfig } from "../runtime-contract";
import type {
  ApprovalCallback,
  AttachmentRef,
  AttachmentUpload,
  AuthMachineryDeps,
  AuthMachineryHandle,
  AuthStatus,
  BackendCapabilities,
  BackendEvent,
  ClientFactory as IClientFactory,
  CustomMcpServer,
  IAutomationManager,
  IBackendProvider,
  IHeartbeatManager,
  IPermissionPolicyProvider,
  ISelfToolDeps,
  ITenantPolicyProvider,
  InferOpts,
  LoginResult,
  RuntimeConfigPayload,
} from "../types";
import { LocalAutomationBackend } from "./automation";
import { forceKillRuntimeClient, isRuntimeClientDead } from "./client-process";
import {
  type LocalClientFactory,
  type LocalClientSubset,
  type LocalSessionSubset,
  type SDKModel,
  RUNTIME_RULE_DENY_PERMISSION_RESULT,
  isConnectionLostError,
  log,
} from "./internal";
import { type PeerClientFactoryResolver, PeerRuntimeClients } from "./peer-clients";
import { LocalPermissionsBackend } from "./permissions";
import { isRuntimeAuthLoginRequest, mapRuntimeAuthLoginResult } from "./runtime-auth";
import { LocalSessionBackend } from "./session";
import { selectSessionClient } from "./session-client";
import type { LocalRuntimeStrategy } from "./strategy";
import { LocalToolBackend } from "./tools";

const MCP_BROKER_FACADES_ENABLED: boolean = false;

export type {
  LocalClientSubset,
  LocalSessionSubset,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from "./internal";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class LocalBackend implements IBackendProvider {
  readonly runtimeId: string;
  readonly origin: IBackendProvider["origin"];
  private client: LocalClientSubset | null = null;
  private clientFactory: LocalClientFactory;
  private workspaceDir: string;
  private readonly strategy: LocalRuntimeStrategy;
  private readonly peers: PeerRuntimeClients;

  // SDK sessions keyed by our internal session ID
  private activeSessions = new Map<string, LocalSessionSubset>();
  // Per-session subscriber lists
  private sessionSubscribers = new Map<string, Set<(event: BackendEvent) => void>>();

  // Approval callback (wired by SessionManager via setApprovalCallback)
  private approvalCallback: ApprovalCallback | null = null;

  // Timezone provider — defaults to system timezone, overridden by SessionManager.
  private getTimezoneProvider: () => string = () =>
    Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Dependencies injected after construction
  private permissionPolicy: IPermissionPolicyProvider | null = null;
  private selfToolDeps: ISelfToolDeps | null = null;
  private customMcpServers: CustomMcpServer[] = [];
  private tenantPolicyProvider: ITenantPolicyProvider | null = null;
  private interceptFileChooser = false;

  // Client lifecycle
  private initPromise: Promise<void> | null = null;
  private signOutPromise: Promise<void> | null = null;
  private signedOut = false;
  private authGeneration = 0;
  // Caches
  private cachedModels: SDKModel[] | null = null;
  private cachedMcpConfig: Record<string, RuntimeMcpServerConfig> | null = null;
  private cachedMcpAccountIdentity: string | null = null;
  private mcpConfigGeneration = 0;
  private mcpBroker: AppMcpBrokerManager | null = null;

  // Sub-interfaces
  readonly sessions: LocalSessionBackend;
  readonly execution: LocalSessionBackend;
  readonly automation: LocalAutomationBackend;
  readonly tools: LocalToolBackend;
  readonly permissions: LocalPermissionsBackend;

  constructor(config: {
    workspaceDir: string;
    clientFactory: IClientFactory;
    strategy: LocalRuntimeStrategy;
    peerClientFactory?: PeerClientFactoryResolver;
  }) {
    this.workspaceDir = config.workspaceDir;
    this.clientFactory = config.clientFactory;
    this.strategy = config.strategy;
    this.runtimeId = config.strategy.runtimeId;
    this.origin = config.strategy.origin;
    this.peers = new PeerRuntimeClients(
      (runtimeId, accountId) =>
        runtimeId === this.runtimeId && !accountId
          ? null
          : (config.peerClientFactory?.(runtimeId, accountId) ?? null),
      config.workspaceDir,
    );
    this.sessions = new LocalSessionBackend(this);
    this.execution = this.sessions;
    this.automation = new LocalAutomationBackend();
    this.tools = new LocalToolBackend(this, config.strategy.preferredDefaultModelIds);
    this.permissions = new LocalPermissionsBackend();
  }

  /** Swap the client factory at runtime (e.g. dev toolbar mock mode toggle). */
  setClientFactory(factory: IClientFactory): void {
    this.clientFactory = factory;
  }

  setPermissionPolicy(policy: IPermissionPolicyProvider): void {
    this.permissionPolicy = policy;
  }

  setSelfToolDeps(deps: ISelfToolDeps): void {
    this.selfToolDeps = deps;
  }

  setCustomMcpServers(servers: CustomMcpServer[]): void {
    this.customMcpServers = servers;
    this.cachedMcpConfig = null;
    this.mcpConfigGeneration += 1;
    const broker = this.mcpBroker;
    this.mcpBroker = null;
    void broker
      ?.dispose()
      .catch((err) => log.warn("Failed to retire MCP broker after server config change:", err));
  }

  setTenantPolicyProvider(provider: ITenantPolicyProvider): void {
    this.tenantPolicyProvider = provider;
  }

  setInterceptFileChooser(intercept: boolean): void {
    this.interceptFileChooser = intercept;
    this.cachedMcpConfig = null;
    this.mcpConfigGeneration += 1;
    const broker = this.mcpBroker;
    this.mcpBroker = null;
    void broker
      ?.dispose()
      .catch((err) => log.warn("Failed to retire MCP broker after Playwright config change:", err));
  }

  setApprovalCallback(callback: ApprovalCallback): void {
    this.approvalCallback = callback;
  }

  /** @internal */ clearApprovalCallback(): void {
    // Used by attachApprovalRouter's detach handler to stop a stale adapter
    // from firing after shutdown / sign-out.
    this.approvalCallback = null;
  }

  setHeartbeatManager(hm: IHeartbeatManager): void {
    this.automation.setHeartbeatManager(hm);
  }

  setSettingsManager(sm: { get(): MSettings; update(patch: Partial<MSettings>): void }): void {
    this.permissions.setSettingsManager(sm);
  }

  setAutomationManager(am: IAutomationManager): void {
    this.automation.setAutomationManager(am);
  }

  setRunActivitySubscriber(subscriber: (listener: () => void) => () => void): void {
    this.automation.setRunActivitySubscriber(subscriber);
  }

  setTimezoneProvider(fn: () => string): void {
    this.getTimezoneProvider = fn;
  }

  loadWorkspaceFiles(): MarshalPromptFiles | null {
    return this.strategy.loadWorkspaceFiles();
  }

  async init(_config?: Record<string, unknown>): Promise<void> {
    await this.initClient();
  }

  async destroy(): Promise<void> {
    // Gracefully stop the SDK client
    if (this.client) {
      try {
        const errors = await this.client.stop();
        if (errors.length > 0) {
          log.warn("client.stop() completed with errors:", errors);
        }
      } catch (err) {
        log.warn("client.stop() threw, force-killing:", err);
        this.killClientProcess();
      }
      this.client = null;
      this.activeSessions.clear();
      this.sessions.clearExecutionState();
    }
    await this.peers.stop();
    await this.disposeMcpBroker();
  }

  isReady(): boolean {
    return this.client !== null;
  }

  /** Check if the CLI subprocess is actually alive (not just that we hold a reference). */
  isProcessAlive(): boolean {
    if (!this.client) return false;
    try {
      const proc = this.client.process;
      if (proc) {
        return proc.exitCode === null && !proc.killed;
      }
    } catch {
      /* fallback to reference check */
    }
    return true; // No process access — assume alive
  }

  capabilities(): BackendCapabilities {
    return this.strategy.capabilities;
  }

  async infer(opts: InferOpts): Promise<string> {
    try {
      opts.signal?.throwIfAborted();
      if (!this.client) {
        await this.initClient();
      }
      opts.signal?.throwIfAborted();
      if (!this.client) {
        throw new Error(`${this.strategy.displayName} client not initialized`);
      }

      const requestedModel = opts.model ?? this.strategy.defaultInferenceModel;
      const model = applyDefaultRuntimeAccount(
        requestedModel ?? "",
        normalizeRuntimeAccounts(this.selfToolDeps?.settingsManager.get().runtimeAccounts),
        this.runtimeId,
      );
      const selection = await selectSessionClient(this, model || undefined);
      const session = await selection.client.createSession({
        clientName: `${APP_NAME}/${app.getVersion()}`,
        model: selection.model,
        systemMessage: { content: opts.systemPrompt },
        availableTools: [],
        ephemeral: true,
        onPermissionRequest: () => RUNTIME_RULE_DENY_PERMISSION_RESULT,
      });

      let abortPromise: Promise<void> | undefined;
      const abortSession = () => {
        abortPromise ??= session.abort().catch((error) => {
          log.warn("Failed to abort inference session:", error);
        });
        return abortPromise;
      };
      let rejectAborted: ((reason: unknown) => void) | undefined;
      const onAbort = () => {
        void abortSession();
        rejectAborted?.(opts.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      try {
        opts.signal?.throwIfAborted();
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        const send = session.sendAndWait({ prompt: opts.userMessage }, opts.timeoutMs ?? 30_000);
        const result = opts.signal
          ? await Promise.race([
              send,
              new Promise<never>((_, reject) => {
                rejectAborted = reject;
                if (opts.signal?.aborted) onAbort();
              }),
            ])
          : await send;
        return result?.data.content ?? "";
      } catch (error) {
        await abortSession();
        throw error;
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
        rejectAborted = undefined;
        await session.destroy().catch(() => {});
      }
    } catch (err) {
      // Emit at the provider so every caller (summarize, auto-title, memory
      // extraction, classifier) is covered automatically.
      // Mirrors the LocalSessionStore.saveSessionData → SESSION_PERSIST_FAILED
      // pattern from a prior review round.
      sendErrorTelemetry(makeSessionError(sessionErrors.INFER_FAILED), err);
      throw err;
    }
  }

  /** @internal */ getClient(): LocalClientSubset | null {
    return this.client;
  }

  /** @internal */ getPermissionPolicy(): IPermissionPolicyProvider | null {
    return this.permissionPolicy;
  }

  /** @internal */ getApprovalCallback(): ApprovalCallback | null {
    return this.approvalCallback;
  }

  /** @internal */ getSelfToolDeps(): ISelfToolDeps | null {
    return this.selfToolDeps;
  }

  /** @internal */ getActiveSession(sessionId: string): LocalSessionSubset | undefined {
    const session = this.activeSessions.get(sessionId);
    // A runtime that tore its session down must read as "no active session" so
    // sessions.ts resumes it from disk instead of every send hitting the dead handle.
    if (session?.isClosed?.()) {
      log.with({ sessionId }).warn("Evicting closed runtime session handle");
      this.activeSessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  /** @internal */ setActiveSession(sessionId: string, session: LocalSessionSubset): void {
    this.activeSessions.set(sessionId, session);
  }

  /** @internal */ deleteActiveSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }

  /** @internal */ getSessionSubscribers(
    sessionId: string,
  ): Set<(event: BackendEvent) => void> | undefined {
    return this.sessionSubscribers.get(sessionId);
  }

  /** @internal */ ensureSessionSubscribers(sessionId: string): Set<(event: BackendEvent) => void> {
    let subs = this.sessionSubscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.sessionSubscribers.set(sessionId, subs);
    }
    return subs;
  }

  /** @internal */ deleteSessionSubscribers(sessionId: string): void {
    this.sessionSubscribers.delete(sessionId);
  }

  /** @internal */ getInterceptFileChooser(): boolean {
    return this.interceptFileChooser;
  }

  /** @internal */ getTimezone(): string {
    return this.getTimezoneProvider();
  }

  /** @internal */ getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  /** @internal */ getRuntimeDisplayName(): string {
    return this.strategy.displayName;
  }

  /** @internal */ getRuntimeId(): string {
    return this.runtimeId;
  }

  /** @internal */ getSessionConfigTraceFilename(): string {
    return this.strategy.sessionConfigTraceFilename;
  }

  /** @internal */ getPeerClients(): PeerRuntimeClients {
    return this.peers;
  }

  /** @internal */ setClientForTesting(client: LocalClientSubset | null): void {
    this.client = client;
  }

  /** @internal */ getActiveSessionsForTesting(): Map<string, LocalSessionSubset> {
    return this.activeSessions;
  }

  /** @internal */ activeSessionCount(): number {
    return this.activeSessions.size;
  }

  /** @internal */ activeSessionIds(): string[] {
    return [...this.activeSessions.keys()];
  }

  /** @internal */ getMcpConfig(
    overrideWorkspaceDir?: string,
    playwrightHeadless = false,
    sessionId?: string,
  ): Record<string, RuntimeMcpServerConfig> {
    // envFile contents are read at config-build time and inlined into MCP env.
    // Bypass the cache when any custom server uses envFile so edits to the .env
    // file (and active-workspace changes that move ${workspaceFolder}) are picked
    // up on the next session start without requiring an app restart.
    const hasEnvFile = this.customMcpServers.some(
      (s) => s.type === "command" && typeof s.envFile === "string" && s.envFile.trim() !== "",
    );
    // Cache only the default path (no override, no headless, no envFile, no sessionId).
    if (
      !overrideWorkspaceDir &&
      !playwrightHeadless &&
      !hasEnvFile &&
      !sessionId &&
      this.cachedMcpConfig
    ) {
      return this.cachedMcpConfig;
    }
    // For ${workspaceFolder} substitution in envFile, resolve the active workspace
    // folder (matches the renderer's workspaceAPI.getRoot()). Falls back to the
    // override when a workspace-scoped session is starting.
    const activeWorkspaceFolder = overrideWorkspaceDir ?? getActiveWorkspaceRoot(this.workspaceDir);

    let playwrightOutputDir: string | undefined;
    let playwrightConfigPath: string | undefined;
    if (sessionId) {
      playwrightOutputDir = path.join(getAppDataDir(), "browser-output", sessionId);
      secureMkdirSync(playwrightOutputDir, 0o700);

      const initScriptPath = app.isPackaged
        ? path.join(process.resourcesPath, "marshal-playwright-init-egress-block.js")
        : path.join(__dirname, "..", "resources", "marshal-playwright-init-egress-block.js");
      const blockedOrigins = this.tenantPolicyProvider?.get()?.browserEgressBlockedOrigins ?? [];
      const egressConfig = buildPlaywrightEgressConfig(initScriptPath, blockedOrigins);

      playwrightConfigPath = path.join(playwrightOutputDir, "playwright-mcp-config.json");
      secureWriteFileSync(playwrightConfigPath, JSON.stringify(egressConfig, null, 2), {
        mode: 0o600,
      });
    }

    const config = buildMcpConfig(
      overrideWorkspaceDir ?? this.workspaceDir,
      this.customMcpServers,
      app.isPackaged,
      this.interceptFileChooser,
      playwrightHeadless,
      activeWorkspaceFolder,
      playwrightOutputDir,
      playwrightConfigPath,
    );
    if (!overrideWorkspaceDir && !playwrightHeadless && !hasEnvFile && !sessionId) {
      this.cachedMcpConfig = config;
    }
    return config;
  }

  /** @internal */ async prepareMcpConfig(
    sessionId: string,
    overrideWorkspaceDir?: string,
    playwrightHeadless = false,
  ): Promise<Record<string, RuntimeMcpServerConfig>> {
    const workspaceDir = overrideWorkspaceDir ?? this.workspaceDir;
    const rawConfig = this.getMcpConfig(overrideWorkspaceDir, playwrightHeadless, sessionId);
    const isServerEnabled = (serverKey: string): boolean =>
      this.permissionPolicy?.isMcpServerEnabledForSession?.(sessionId, serverKey) ?? true;
    const filtered = Object.fromEntries(
      Object.entries(rawConfig).filter(([serverKey]) => isServerEnabled(serverKey)),
    );
    if (Object.keys(filtered).length === 0) {
      await this.mcpBroker?.releaseSession(sessionId);
      return {};
    }

    if (!MCP_BROKER_FACADES_ENABLED) {
      await this.mcpBroker?.releaseSession(sessionId);
      return filtered;
    }

    const broker = await this.getOrCreateMcpBroker();
    return broker.prepareSessionConfig({
      sessionId,
      mcpServers: filtered,
      workspaceDir,
      identityKey: await this.getMcpIdentityKey(),
      configGeneration: this.mcpConfigGeneration,
      isServerEnabled,
    });
  }

  /** @internal */ async releaseMcpSession(sessionId: string): Promise<void> {
    await this.mcpBroker?.releaseSession(sessionId);
  }

  private async getMcpIdentityKey(): Promise<string> {
    const identities = [`os:${os.userInfo().username.toLowerCase()}`];
    if (this.cachedMcpAccountIdentity) {
      identities.push(this.cachedMcpAccountIdentity);
    } else {
      try {
        const status = await this.client?.getAuthStatus();
        if (status?.isAuthenticated && status.login) {
          this.cachedMcpAccountIdentity = `${this.strategy.accountIdentityPrefix}:${status.login.toLowerCase()}`;
          identities.push(this.cachedMcpAccountIdentity);
        }
      } catch {
        // OS/principal identity remains a conservative partition when GitHub auth probing fails.
      }
    }
    return identities.join("|");
  }

  private async getOrCreateMcpBroker(): Promise<AppMcpBrokerManager> {
    if (this.mcpBroker) return this.mcpBroker;
    const { AppMcpBrokerManager } = await import("../../mcp-broker-manager");
    return (this.mcpBroker ??= new AppMcpBrokerManager());
  }

  private async disposeMcpBroker(): Promise<void> {
    const broker = this.mcpBroker;
    this.mcpBroker = null;
    if (broker) await broker.dispose();
  }

  /** @internal */ async initClient(): Promise<void> {
    if (this.client && isRuntimeClientDead(this.client)) {
      // The runtime process died under us (crash, OOM, sleep/wake). Its session
      // handles report closed and are evicted; the next create/resume needs a
      // live client to resume the thread from disk.
      log.warn("Replacing a runtime client whose process has exited");
      this.killClientProcess();
      this.client = null;
    }
    if (this.client) return;
    if (this.signedOut || this.signOutPromise) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInitClient();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async _doInitClient(): Promise<void> {
    this.client = await this.clientFactory(this.workspaceDir);

    if (this.signedOut || this.signOutPromise) {
      this.killClientProcess();
      this.client = null;
    }
  }

  async resetClient(): Promise<void> {
    this.killClientProcess();
    this.peers.kill();
    this.sessions.clearExecutionState();
    this.client = null;
    this.initPromise = null;
    this.cachedModels = null;
    this.cachedMcpConfig = null;
    this.strategy.auth?.clearCachedState?.();
    this.cachedMcpAccountIdentity = null;
    await this.disposeMcpBroker();
    log.info("Client reset");
  }

  async restart(): Promise<void> {
    this.killClientProcess();
    this.peers.kill();
    this.sessions.clearExecutionState();
    this.client = null;
    this.initPromise = null;
    this.cachedModels = null;
    this.cachedMcpConfig = null;
    this.activeSessions.clear();
    this.strategy.auth?.clearCachedState?.();
    this.cachedMcpAccountIdentity = null;
    await this.disposeMcpBroker();
    log.info("Backend restarted — caller must call init() when ready");
  }

  isHealthy(): boolean {
    return this.isProcessAlive();
  }

  /** Rule-3 symmetric no-op — local auth lives outside gatewayAuth:*.
   *  Stubs the gatewayAuth:* channels so `useGatewayAuth` doesn't 404 if the
   *  renderer surfaces it without a restart. */
  attachAuthMachinery(deps: AuthMachineryDeps): AuthMachineryHandle {
    deps.ipcHandle("gatewayAuth:getState", async () => ({
      success: true as const,
      state: { status: "picking" as const },
    }));
    deps.ipcHandle("gatewayAuth:signIn", async () => ({
      success: false,
      error: "Gateway backend not enabled — select the Gateway runtime and restart the app.",
    }));
    deps.ipcHandle("gatewayAuth:signOut", async () => ({ success: true }));
    deps.ipcHandle("gatewayAuth:cancelPairing", async () => ({ success: true }));
    // Local runtimes never have a gateway URL to call,
    // so report "not supported in this environment" with the same sentinel
    // the gateway controller uses. Renderer hides the panel either way.
    deps.ipcHandle("gatewayAuth:listPendingDevices", async () => ({
      success: false,
      error: "not-supported-non-local",
    }));
    deps.ipcHandle("gatewayAuth:approveDevice", async () => ({
      success: false,
      error: "not-supported-non-local",
    }));
    return {
      getState: () => null,
      tryAutoSignIn: async () => {},
      // Local runtime auth does not have the gateway's post-sign-in reconnect
      setReconnecting: () => {},
    };
  }

  setOnAutomationsChangedBroadcaster(_fn: (() => void) | null): void {
    // Local runtimes update automation state synchronously via AutomationManager.
  }

  registerNodeIpcHandlers(_deps: {
    ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
    broadcast: <C extends keyof IpcEventMap>(channel: C, payload: IpcEventMap[C]) => void;
  }): void {
    // No-op (Rule 3): gateway-node IPC handlers are gateway-only.
  }

  async dispose(): Promise<void> {
    await this.disposeMcpBroker();
  }

  async forceKill(): Promise<void> {
    this.killClientProcess();
    this.peers.kill();
    this.sessions.clearExecutionState();
    this.client = null;
    this.activeSessions.clear();
    await this.disposeMcpBroker();
  }

  /** @internal */ async forceKillActiveRuntime(options?: {
    interruptedSessionId?: string;
  }): Promise<string[]> {
    const invalidatedSessionIds = [...this.activeSessions.keys()];
    if (
      options?.interruptedSessionId &&
      !invalidatedSessionIds.includes(options.interruptedSessionId)
    ) {
      invalidatedSessionIds.push(options.interruptedSessionId);
    }
    await this.forceKill();
    this.activeSessions.clear();
    return invalidatedSessionIds;
  }

  /** @internal */ killClientProcess(): void {
    if (this.client) forceKillRuntimeClient(this.client);
  }

  async checkAuthStatus(): Promise<AuthStatus> {
    if (this.signedOut) return { authenticated: false };
    const authGeneration = this.authGeneration;
    if (!this.client) {
      if (this.signOutPromise) {
        return { authenticated: false };
      }
      await this.initClient();
    }

    try {
      const status = await this.client!.getAuthStatus();
      if (this.signedOut || authGeneration !== this.authGeneration) {
        return { authenticated: false };
      }
      const augmented = await this.augmentAuthStatus({
        authenticated: status.isAuthenticated,
        username: status.login,
        statusMessage: status.statusMessage,
      });
      return this.signedOut || authGeneration !== this.authGeneration
        ? { authenticated: false }
        : augmented;
    } catch (error) {
      if (isConnectionLostError(error)) {
        log.warn("Connection lost during auth check, reinitializing...");
        this.killClientProcess();
        this.client = null;
        try {
          if (this.signedOut || authGeneration !== this.authGeneration) {
            return { authenticated: false };
          }
          await this.initClient();
          const status = await this.client!.getAuthStatus();
          if (this.signedOut || authGeneration !== this.authGeneration) {
            return { authenticated: false };
          }
          const augmented = await this.augmentAuthStatus({
            authenticated: status.isAuthenticated,
            username: status.login,
            statusMessage: status.statusMessage,
          });
          return this.signedOut || authGeneration !== this.authGeneration
            ? { authenticated: false }
            : augmented;
        } catch (retryError) {
          log.error("Auth check retry failed:", retryError);
        }
      }
      log.error("Failed to check auth status:", error);
      return { authenticated: false };
    }
  }

  private async augmentAuthStatus(status: AuthStatus): Promise<AuthStatus> {
    if (!this.client || !this.strategy.auth?.augmentStatus) return status;
    return this.strategy.auth.augmentStatus(this.client, status);
  }

  async login(credentials?: unknown): Promise<LoginResult> {
    const wasSignedOut = this.signedOut;
    this.authGeneration += 1;
    this.signedOut = false;
    try {
      if (this.strategy.auth?.login) {
        return await this.strategy.auth.login(credentials);
      }
      if (!this.client) await this.initClient();
      const client = this.client;
      if (!client?.login) {
        throw new Error(`${this.strategy.displayName} runtime does not expose a login method`);
      }
      const request =
        credentials === undefined
          ? this.strategy.defaultClientLoginRequest
          : isRuntimeAuthLoginRequest(credentials)
            ? credentials
            : undefined;
      if (!request) {
        throw new Error(`${this.strategy.displayName} login requires a typed runtime auth request`);
      }
      return mapRuntimeAuthLoginResult(client, await client.login(request));
    } catch (error) {
      if (wasSignedOut) {
        this.signedOut = true;
        this.killClientProcess();
        this.client = null;
        this.initPromise = null;
      }
      throw error;
    }
  }

  async signOut(): Promise<void> {
    if (this.signOutPromise) {
      return this.signOutPromise;
    }

    this.signedOut = true;
    this.authGeneration += 1;
    let resolveSignOut!: () => void;
    this.signOutPromise = new Promise<void>((r) => {
      resolveSignOut = r;
    });

    this.strategy.auth?.cancelPendingLogin?.();
    const client = this.client;
    let clientLogoutError: unknown;
    if (!this.strategy.auth?.logout && client?.logout) {
      try {
        await client.logout();
      } catch (error) {
        clientLogoutError = error;
      }
    }
    this.killClientProcess();
    this.peers.kill();
    this.client = null;
    this.initPromise = null;
    this.activeSessions.clear();
    this.sessions.clearExecutionState();
    this.cachedModels = null;
    this.cachedMcpConfig = null;
    this.cachedMcpAccountIdentity = null;
    this.strategy.auth?.clearCachedState?.();
    const disposeMcpBroker = this.disposeMcpBroker();

    try {
      await Promise.all([this.strategy.auth?.logout?.() ?? Promise.resolve(), disposeMcpBroker]);
      if (clientLogoutError) throw clientLogoutError;
    } finally {
      resolveSignOut();
      this.signOutPromise = null;
    }
  }

  async uploadAttachment(file: AttachmentUpload): Promise<AttachmentRef> {
    // Local runtimes handle attachments inline in the send payload —
    // no pre-upload step is needed. Return a pass-through ref using the
    // file path as ID since the SDK reads files locally by path.
    return {
      id: file.path,
      type: file.type,
      displayName: file.displayName,
    };
  }

  async pushConfig(_config: RuntimeConfigPayload): Promise<void> {
    // Local runtime configuration is baked into session creation.
    // Skills, soul, memories, etc. are injected via the system message.
  }

  /** @internal */
  async listModels(): Promise<SDKModel[]> {
    if (this.cachedModels) return this.filterDisabledModels(this.cachedModels);
    if (!this.client) {
      await this.initClient();
    }
    try {
      const models = await this.client!.listModels();
      this.cachedModels = this.filterUnavailableModels(models);
      return this.filterDisabledModels(this.cachedModels);
    } catch (error) {
      log.error("Failed to list models:", error);
      if (isAuthError(error)) throw error;
      return [];
    }
  }

  /**
   * Drops SDK-listed models that still fail `session.create()` with
   * `Model "X" is not available.`. Run before caching so `listModels()` and
   * `getCachedModels()` expose the same availability-filtered catalog.
   */
  private filterUnavailableModels(models: SDKModel[]): SDKModel[] {
    const dropped: string[] = [];
    const filtered = models.filter((m) => {
      const state = m.policy?.state;
      if (state == null || state === "enabled") return true;
      dropped.push(`${m.id ?? "?"}=${state}`);
      return false;
    });
    if (dropped.length > 0) {
      log.info(`Filtered ${dropped.length} unavailable model(s): ${dropped.join(", ")}`);
    }
    return filtered;
  }

  private filterDisabledModels(models: SDKModel[]): SDKModel[] {
    const policy = this.tenantPolicyProvider?.get();
    const disabledModels = policy?.disabledModels;
    const disabledProviders = policy?.disabledProviders;
    if (!disabledModels?.length && !disabledProviders?.length) return models;

    const modelBlocklist = new Set(disabledModels?.map((m: string) => m.toLowerCase()) ?? []);
    const providerBlocklist = new Set(disabledProviders?.map((p: string) => p.toLowerCase()) ?? []);

    return models.filter((m) => {
      const id = (m.id ?? "").toLowerCase();
      if (modelBlocklist.has(id)) return false;
      // SDK models do not declare `provider`, but tenant policy can still
      // blocklist by provider.
      const provider =
        "provider" in m && typeof m.provider === "string" ? m.provider.toLowerCase() : "";
      if (provider && providerBlocklist.has(provider)) return false;
      return true;
    });
  }

  /** Synchronous access to cached model list (may be null if not yet fetched). */
  getCachedModels(): SDKModel[] | null {
    return this.cachedModels;
  }

  /** Dormant — no production caller. SDK setApproveAll bypasses Marshal's
   *  audit pipeline; wire a real caller carefully. */
  async setApproveAllForActiveSessions(enabled: boolean): Promise<void> {
    await Promise.all(
      [...this.activeSessions.values()].map(async (session) => {
        const result = await session.rpc?.permissions?.setApproveAll({ enabled });
        if (result && !result.success) {
          throw new Error("SDK setApproveAll returned success=false");
        }
      }),
    );
  }

  async resetSdkSessionApprovals(sessionId?: string): Promise<void> {
    const sessions = sessionId
      ? [this.activeSessions.get(sessionId)].filter((s): s is LocalSessionSubset => !!s)
      : [...this.activeSessions.values()];
    await Promise.all(
      sessions.map(async (session) => {
        const result = await session.rpc?.permissions?.resetSessionApprovals();
        if (result && !result.success) {
          throw new Error("SDK resetSessionApprovals returned success=false");
        }
      }),
    );
  }
}
