import type { McpServerInfo, ModelInfo } from "../../../common/marshal-ipc-contract";
import type { RuntimeTool } from "../runtime-contract";
import type {
  AttachApprovalRouterDeps,
  AttachDesktopCapabilitiesDeps,
  IToolBackend,
  LocalMcpConfig,
  ToolPolicyConfig,
} from "../types";
import { DesktopCapabilitiesBridge } from "./desktop-capabilities/bridge";
import { DesktopCapabilitiesImpl } from "./desktop-capabilities/desktop-capabilities";
import { makeEvaluateLocalPolicyHandler } from "./desktop-capabilities/evaluate-local-policy";
import { makeShowApprovalCardHandler } from "./desktop-capabilities/show-approval-card";
import type { IGatewayWsClient } from "./ws-client";

/** Subset of `AttachApprovalRouterDeps` the gateway handlers actually touch. */
interface GatewayApprovalRouterDeps {
  broker: AttachApprovalRouterDeps["broker"];
  policy: AttachApprovalRouterDeps["policy"];
}

export class GatewayToolBackend implements IToolBackend {
  private client: IGatewayWsClient | null = null;
  private cachedModels: ModelInfo[] | null = null;
  private cacheExpiry = 0;
  private static readonly MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
  /** Deps from `attachApprovalRouter`, retained across reconnects. The
   *  `attachApprovalRouter` call lands once at startup (main.ts wiring), but
   *  the WS client is rebuilt on every reconnect / sign-in — we keep the deps
   *  so each `attachClient(newClient)` can re-register the inbound handlers
   *  on the fresh socket without main.ts having to call attachApprovalRouter
   *  again. Cleared by the detach fn returned from attachApprovalRouter. */
  private approvalRouterDeps: GatewayApprovalRouterDeps | null = null;
  /** Per-client unregister functions for the approval-router WS handlers.
   *  Populated when handlers register; emptied on detach / client change. */
  private approvalRouterUnregisters: Array<() => void> = [];

  /** Deps from `attachDesktopCapabilities`, retained across reconnects.
   *  Same lifecycle as `approvalRouterDeps`. Cleared by the detach fn. */
  private desktopCapabilitiesDeps: AttachDesktopCapabilitiesDeps | null = null;
  /** Lazy resolver for self-tools — populated by GatewayBackend when
   *  SessionManager pushes self-tool deps. Returns null until then. */
  private selfToolsResolver: (sessionId: string) => readonly RuntimeTool[] | null = () => null;
  private _desktopCapabilities: DesktopCapabilitiesImpl | null = null;
  private _desktopBridge: DesktopCapabilitiesBridge | null = null;

  /** Called by `GatewayBackend.setSelfToolDeps` to forward the self-tool
   *  registry into the desktop-capabilities composition. Kept as a setter
   *  so the tool backend doesn't depend on `SelfToolDeps` directly. */
  setSelfToolsResolver(resolver: (sessionId: string) => readonly RuntimeTool[] | null): void {
    this.selfToolsResolver = resolver;
    // Rebuild the bridge against the existing client so the new resolver
    // takes effect — without this, a self-tool registry change after init()
    // wouldn't surface to executeLocalTool until the next reconnect.
    if (this.client && this.desktopCapabilitiesDeps) {
      this.attachDesktopCapabilitiesBridge(this.client);
    }
  }

  attachClient(client: IGatewayWsClient): void {
    // Unregister handles tied to the previous client — same hazard as
    // detachClient: a still-alive old client could keep firing stale
    // approval-router handlers after we've moved to a new socket. The
    // previous client may have been replaced asynchronously and its
    // inboundHandlers map outlives this call.
    for (const unregister of this.approvalRouterUnregisters) unregister();
    this.approvalRouterUnregisters = [];
    // Same for the desktop-capabilities bridge — drop the prior
    // attachment before swapping clients.
    if (this._desktopBridge) {
      this._desktopBridge.detach();
      this._desktopBridge = null;
    }
    this._desktopCapabilities = null;
    this.client = client;
    // Invalidate cache when the client changes (e.g. sign out + sign in).
    this.cachedModels = null;
    this.cacheExpiry = 0;
    // If attachApprovalRouter has already been called, the deps survive the
    // reconnect — re-register the handlers on this fresh client.
    if (this.approvalRouterDeps) {
      this.registerApprovalRouterHandlers(client, this.approvalRouterDeps);
    }
    // Same for desktop-capabilities: rebuild the bridge against the new
    // client when deps survived a prior `attachDesktopCapabilities` call.
    if (this.desktopCapabilitiesDeps) {
      this.attachDesktopCapabilitiesBridge(client);
    }
  }

  /**
   * Wire the gateway's approval transport: register
   * `desktop.evaluateLocalPolicy` and `desktop.showApprovalCard` as inbound
   * RPC handlers on the WS client. The cloud invokes these when marshal
   * needs the desktop to evaluate local policy or surface an interactive
   * approval card.
   *
   * Idempotent across reconnects: deps are stored and re-applied to each
   * fresh WS client via `attachClient`. If no client is currently attached
   * (init() hasn't run yet), registration defers until one is.
   *
   * `classifier` and `canShowUI` from the deps are unused here — see the
   * `GatewayApprovalRouterDeps` doc comment.
   */
  attachApprovalRouter(deps: AttachApprovalRouterDeps): () => void {
    const concrete: GatewayApprovalRouterDeps = {
      broker: deps.broker,
      policy: deps.policy,
    };
    this.approvalRouterDeps = concrete;
    if (this.client) {
      this.registerApprovalRouterHandlers(this.client, concrete);
    }
    return () => {
      // Drop deps + unregister so a stale handler can't fire after sign-out.
      // Same rationale as copilot's clearApprovalCallback() detach.
      this.approvalRouterDeps = null;
      for (const unreg of this.approvalRouterUnregisters) unreg();
      this.approvalRouterUnregisters = [];
    };
  }

  private registerApprovalRouterHandlers(
    client: IGatewayWsClient,
    deps: GatewayApprovalRouterDeps,
  ): void {
    const evaluateLocalPolicy = makeEvaluateLocalPolicyHandler({ policy: deps.policy });
    const showApprovalCard = makeShowApprovalCardHandler({
      broker: deps.broker,
      policy: deps.policy,
    });
    // oxlint-disable @typescript-eslint/no-unsafe-type-assertion -- params come off the wire as Record<string, unknown>; per-RPC schemas are validated inside the handler factories
    const unregEval = client.registerInboundHandler("desktop.evaluateLocalPolicy", async (params) =>
      evaluateLocalPolicy(params as never),
    );
    const unregShow = client.registerInboundHandler("desktop.showApprovalCard", async (params) =>
      showApprovalCard(params as never),
    );
    // oxlint-enable @typescript-eslint/no-unsafe-type-assertion
    this.approvalRouterUnregisters = [unregEval, unregShow];
  }

  /**
   * Wire desktop-only capabilities — `executeShell`'s defense-in-depth
   * policy gate and the optional `showNotification` click router. Same
   * lifecycle shape as `attachApprovalRouter`: deps survive across
   * reconnects (re-applied via `attachClient` on each fresh client), the
   * detach fn drops them and tears down the bridge.
   */
  attachDesktopCapabilities(deps: AttachDesktopCapabilitiesDeps): () => void {
    this.desktopCapabilitiesDeps = deps;
    if (this.client) {
      this.attachDesktopCapabilitiesBridge(this.client);
    }
    return () => {
      this.desktopCapabilitiesDeps = null;
      if (this._desktopBridge) {
        this._desktopBridge.detach();
        this._desktopBridge = null;
      }
      this._desktopCapabilities = null;
    };
  }

  /**
   * Build the `DesktopCapabilitiesImpl` + `DesktopCapabilitiesBridge` and
   * attach the bridge to the given WS client. Idempotent — replaces any
   * existing attachment so a stale impl isn't kept around.
   */
  private attachDesktopCapabilitiesBridge(client: IGatewayWsClient): void {
    const deps = this.desktopCapabilitiesDeps;
    if (!deps) return;
    if (this._desktopBridge) {
      this._desktopBridge.detach();
      this._desktopBridge = null;
    }
    this._desktopCapabilities = new DesktopCapabilitiesImpl({
      policy: deps.policy,
      toolInvocationManager: deps.toolInvocationManager,
      onSessionOpenRequested: deps.onSessionOpenRequested,
      mcpRuntime: null, // see execute-mcp-tool.ts — ships with lobster's localTools rollout
      getSelfTools: this.selfToolsResolver,
    });
    this._desktopBridge = new DesktopCapabilitiesBridge(this._desktopCapabilities);
    this._desktopBridge.attach(client);
  }

  async getToolPolicy(): Promise<ToolPolicyConfig> {
    throw new Error("GatewayBackend: tool policy not supported in Phase 1");
  }

  async updateToolPolicy(_patch: Partial<ToolPolicyConfig>): Promise<void> {
    throw new Error("GatewayBackend: tool policy not supported in Phase 1");
  }

  async getMcpServers(): Promise<McpServerInfo[]> {
    throw new Error("GatewayBackend: MCP servers not supported in Phase 1");
  }

  async registerLocalMcp(_config: LocalMcpConfig): Promise<void> {
    throw new Error("GatewayBackend: MCP servers not supported in Phase 1");
  }

  async unregisterLocalMcp(_name: string): Promise<void> {
    throw new Error("GatewayBackend: MCP servers not supported in Phase 1");
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.client) return [];
    const now = Date.now();
    if (this.cachedModels && now < this.cacheExpiry) return this.cachedModels;
    const res = await this.client.modelsList();
    this.cachedModels = res.models.map((m) => ({ id: m.id, name: m.name }));
    this.cacheExpiry = now + GatewayToolBackend.MODEL_CACHE_TTL_MS;
    return this.cachedModels;
  }

  getCachedModels(): ModelInfo[] | null {
    return this.cachedModels;
  }

  /** Gateway's preferred default chain — Anthropic Claude flagship line.
   *  Order: latest sonnet (good general default), then opus (most capable),
   *  then haiku (fastest). Hyphenated wire form per gateway model-id rules. */
  private static readonly PREFERRED_DEFAULT_IDS = [
    "claude-sonnet-4-6",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-haiku-4-5-20251001",
  ] as const;

  getDefaultModel(): string | undefined {
    const cached = this.cachedModels;
    if (!cached || cached.length === 0) return undefined;
    const ids = new Set(cached.map((m) => m.id));
    for (const preferred of GatewayToolBackend.PREFERRED_DEFAULT_IDS) {
      if (ids.has(preferred)) return preferred;
    }
    // No preferred match — fall back to any claude-* id, then any id.
    return cached.find((m) => m.id.startsWith("claude-"))?.id ?? cached[0]?.id;
  }

  /** Detach the WS client, drop the model cache, and unregister the
   *  approval-router + desktop-capabilities handlers on the soon-to-die
   *  client. Calls the unregister fns rather than just clearing the array:
   *  the old client may still be alive mid-message and would otherwise
   *  keep firing stale desktop.* handlers on a torn-down backend.
   *
   *  Deps from `attachApprovalRouter` / `attachDesktopCapabilities` are NOT
   *  touched — those survive so the next `attachClient(newClient)` rebuilds
   *  on the fresh socket. Their lifecycle is owned by the detach fns
   *  returned to main.ts. */
  detachClient(): void {
    for (const unregister of this.approvalRouterUnregisters) unregister();
    this.approvalRouterUnregisters = [];
    // Also tear down the desktop-capabilities bridge — same hazard: a still
    // alive WS client must not retain stale desktop.* handlers after the
    // backend has been torn down. Deps survive (next attachClient rebuilds).
    if (this._desktopBridge) {
      this._desktopBridge.detach();
      this._desktopBridge = null;
    }
    this._desktopCapabilities = null;
    this.client = null;
    this.cachedModels = null;
    this.cacheExpiry = 0;
  }
}
