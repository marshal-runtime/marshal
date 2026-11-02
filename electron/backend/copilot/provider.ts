import type {
  IpcEventMap,
  IpcHandler,
  IpcInvokeMap,
  MSettings,
} from "../../../common/marshal-ipc-contract";
import type { LocalClientSubset, LocalSessionSubset, SDKModel } from "../local/internal";
import { LocalBackend } from "../local/provider";
import type { LocalSessionBackend } from "../local/session";
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
  ClientFactory,
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
import { createCopilotLocalRuntimeStrategy } from "./strategy";

export type {
  LocalClientSubset as CopilotClientSubset,
  LocalSessionSubset as CopilotSessionSubset,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from "../local/internal";

export class CopilotBackend implements IBackendProvider {
  private readonly local: LocalBackend;

  constructor(config: { workspaceDir: string; clientFactory: ClientFactory }) {
    this.local = new LocalBackend({
      ...config,
      strategy: createCopilotLocalRuntimeStrategy(),
    });
  }

  get runtimeId(): string {
    return this.local.runtimeId;
  }

  get origin(): IBackendProvider["origin"] {
    return this.local.origin;
  }

  get sessions(): LocalSessionBackend {
    return this.local.sessions;
  }

  get execution(): LocalSessionBackend {
    return this.local.execution;
  }

  get automation(): IBackendProvider["automation"] {
    return this.local.automation;
  }

  get tools(): IBackendProvider["tools"] {
    return this.local.tools;
  }

  get permissions(): IBackendProvider["permissions"] {
    return this.local.permissions;
  }

  /** @internal Test compatibility accessor. */
  get client(): LocalClientSubset | null {
    return this.local.getClient();
  }

  set client(client: LocalClientSubset | null) {
    this.local.setClientForTesting(client);
  }

  /** @internal Test compatibility accessor. */
  get activeSessions(): Map<string, LocalSessionSubset> {
    return this.local.getActiveSessionsForTesting();
  }

  setClientFactory(factory: ClientFactory): void {
    this.local.setClientFactory(factory);
  }

  setPermissionPolicy(policy: IPermissionPolicyProvider): void {
    this.local.setPermissionPolicy(policy);
  }

  setSelfToolDeps(deps: ISelfToolDeps): void {
    this.local.setSelfToolDeps(deps);
  }

  setCustomMcpServers(servers: CustomMcpServer[]): void {
    this.local.setCustomMcpServers(servers);
  }

  setTenantPolicyProvider(provider: ITenantPolicyProvider): void {
    this.local.setTenantPolicyProvider(provider);
  }

  setInterceptFileChooser(intercept: boolean): void {
    this.local.setInterceptFileChooser(intercept);
  }

  setApprovalCallback(callback: ApprovalCallback): void {
    this.local.setApprovalCallback(callback);
  }

  clearApprovalCallback(): void {
    this.local.clearApprovalCallback();
  }

  setHeartbeatManager(manager: IHeartbeatManager): void {
    this.local.setHeartbeatManager(manager);
  }

  setSettingsManager(manager: { get(): MSettings; update(patch: Partial<MSettings>): void }): void {
    this.local.setSettingsManager(manager);
  }

  setAutomationManager(manager: IAutomationManager): void {
    this.local.setAutomationManager(manager);
  }

  setRunActivitySubscriber(subscriber: (listener: () => void) => () => void): void {
    this.local.setRunActivitySubscriber(subscriber);
  }

  setTimezoneProvider(provider: () => string): void {
    this.local.setTimezoneProvider(provider);
  }

  loadWorkspaceFiles(): MarshalPromptFiles {
    return this.local.loadWorkspaceFiles() ?? {};
  }

  init(config?: Record<string, unknown>): Promise<void> {
    return this.local.init(config);
  }

  destroy(): Promise<void> {
    return this.local.destroy();
  }

  isReady(): boolean {
    return this.local.isReady();
  }

  isProcessAlive(): boolean {
    return this.local.isProcessAlive();
  }

  capabilities(): BackendCapabilities {
    return this.local.capabilities();
  }

  infer(opts: InferOpts): Promise<string> {
    return this.local.infer(opts);
  }

  getClient(): LocalClientSubset | null {
    return this.local.getClient();
  }

  getPermissionPolicy(): IPermissionPolicyProvider | null {
    return this.local.getPermissionPolicy();
  }

  getApprovalCallback(): ApprovalCallback | null {
    return this.local.getApprovalCallback();
  }

  getSelfToolDeps(): ISelfToolDeps | null {
    return this.local.getSelfToolDeps();
  }

  getActiveSession(sessionId: string): LocalSessionSubset | undefined {
    return this.local.getActiveSession(sessionId);
  }

  setActiveSession(sessionId: string, session: LocalSessionSubset): void {
    this.local.setActiveSession(sessionId, session);
  }

  deleteActiveSession(sessionId: string): void {
    this.local.deleteActiveSession(sessionId);
  }

  getSessionSubscribers(sessionId: string): Set<(event: BackendEvent) => void> | undefined {
    return this.local.getSessionSubscribers(sessionId);
  }

  ensureSessionSubscribers(sessionId: string): Set<(event: BackendEvent) => void> {
    return this.local.ensureSessionSubscribers(sessionId);
  }

  deleteSessionSubscribers(sessionId: string): void {
    this.local.deleteSessionSubscribers(sessionId);
  }

  getInterceptFileChooser(): boolean {
    return this.local.getInterceptFileChooser();
  }

  getTimezone(): string {
    return this.local.getTimezone();
  }

  getWorkspaceDir(): string {
    return this.local.getWorkspaceDir();
  }

  activeSessionCount(): number {
    return this.local.activeSessionCount();
  }

  activeSessionIds(): string[] {
    return this.local.activeSessionIds();
  }

  getMcpConfig(
    overrideWorkspaceDir?: string,
    playwrightHeadless?: boolean,
    sessionId?: string,
  ): Record<string, RuntimeMcpServerConfig> {
    return this.local.getMcpConfig(overrideWorkspaceDir, playwrightHeadless, sessionId);
  }

  prepareMcpConfig(
    sessionId: string,
    overrideWorkspaceDir?: string,
    playwrightHeadless?: boolean,
  ): Promise<Record<string, RuntimeMcpServerConfig>> {
    return this.local.prepareMcpConfig(sessionId, overrideWorkspaceDir, playwrightHeadless);
  }

  releaseMcpSession(sessionId: string): Promise<void> {
    return this.local.releaseMcpSession(sessionId);
  }

  initClient(): Promise<void> {
    return this.local.initClient();
  }

  resetClient(): Promise<void> {
    return this.local.resetClient();
  }

  restart(): Promise<void> {
    return this.local.restart();
  }

  isHealthy(): boolean {
    return this.local.isHealthy();
  }

  attachAuthMachinery(deps: AuthMachineryDeps): AuthMachineryHandle {
    return this.local.attachAuthMachinery(deps);
  }

  setOnAutomationsChangedBroadcaster(fn: (() => void) | null): void {
    this.local.setOnAutomationsChangedBroadcaster(fn);
  }

  registerNodeIpcHandlers(deps: {
    ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
    broadcast: <C extends keyof IpcEventMap>(channel: C, payload: IpcEventMap[C]) => void;
  }): void {
    this.local.registerNodeIpcHandlers(deps);
  }

  dispose(): Promise<void> {
    return this.local.dispose();
  }

  forceKill(): Promise<void> {
    return this.local.forceKill();
  }

  forceKillActiveRuntime(options?: { interruptedSessionId?: string }): Promise<string[]> {
    return this.local.forceKillActiveRuntime(options);
  }

  killClientProcess(): void {
    this.local.killClientProcess();
  }

  checkAuthStatus(): Promise<AuthStatus> {
    return this.local.checkAuthStatus();
  }

  login(credentials?: unknown): Promise<LoginResult> {
    return this.local.login(credentials);
  }

  signOut(): Promise<void> {
    return this.local.signOut();
  }

  uploadAttachment(file: AttachmentUpload): Promise<AttachmentRef> {
    return this.local.uploadAttachment(file);
  }

  pushConfig(config: RuntimeConfigPayload): Promise<void> {
    return this.local.pushConfig(config);
  }

  listModels(): Promise<SDKModel[]> {
    return this.local.listModels();
  }

  getCachedModels(): SDKModel[] | null {
    return this.local.getCachedModels();
  }

  setApproveAllForActiveSessions(enabled: boolean): Promise<void> {
    return this.local.setApproveAllForActiveSessions(enabled);
  }

  resetSdkSessionApprovals(sessionId?: string): Promise<void> {
    return this.local.resetSdkSessionApprovals(sessionId);
  }
}
