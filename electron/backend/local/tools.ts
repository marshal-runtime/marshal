import type { ModelInfo, McpServerInfo } from "../../../common/marshal-ipc-contract";
import type {
  AttachApprovalRouterDeps,
  AttachDesktopCapabilitiesDeps,
  IToolBackend,
  LocalMcpConfig,
  ToolPolicyConfig,
} from "../types";
import { createApprovalCallbackAdapter } from "./approval-adapter";
import type { ILocalProviderForTools } from "./internal";

export class LocalToolBackend implements IToolBackend {
  constructor(
    private backend: ILocalProviderForTools,
    private readonly preferredDefaultIds: readonly string[],
  ) {}

  /**
   * Wires the SDK's permission callback to the shared ApprovalBroker via
   * `createApprovalCallbackAdapter`. Detach clears the callback so a stale
   * adapter (e.g., from a previous SessionManager) cannot fire after shutdown.
   */
  attachApprovalRouter(deps: AttachApprovalRouterDeps): () => void {
    const adapter = createApprovalCallbackAdapter(deps);
    this.backend.setApprovalCallback(adapter);
    return () => {
      // Clear so a stale adapter cannot fire after shutdown / sign-out.
      this.backend.clearApprovalCallback();
    };
  }

  attachDesktopCapabilities(_deps: AttachDesktopCapabilitiesDeps): () => void {
    // Local runtimes evaluate these concerns in-process rather than through
    // the gateway's desktop.* RPC bridge.
    return () => {};
  }

  async getToolPolicy(): Promise<ToolPolicyConfig> {
    // Phase 1 stub — tool policy is managed by PermissionPolicy in sessions.ts
    return {
      autoApproveAll: false,
      autoApproveReadOnly: false,
      allow: [],
      tools: {},
      servers: {},
    };
  }

  async updateToolPolicy(patch: Partial<ToolPolicyConfig>): Promise<void> {
    // autoApproveAll is dormant Phase-2 plumbing — no production caller today.
    // See setApproveAllForActiveSessions for the audit-bypass caveat.
    if (typeof patch.autoApproveAll === "boolean") {
      await this.backend.setApproveAllForActiveSessions(patch.autoApproveAll);
      return;
    }
    throw new Error("updateToolPolicy() only supports autoApproveAll in Phase 1");
  }

  async getMcpServers(): Promise<McpServerInfo[]> {
    throw new Error("getMcpServers() not implemented in Phase 1");
  }

  async registerLocalMcp(_config: LocalMcpConfig): Promise<void> {
    throw new Error("registerLocalMcp() not implemented in Phase 1");
  }

  async unregisterLocalMcp(_name: string): Promise<void> {
    throw new Error("unregisterLocalMcp() not implemented in Phase 1");
  }

  async listModels(): Promise<ModelInfo[]> {
    const models = await this.backend.listModels();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- backend boundary cast: IPC `ModelInfo` is a loose subset of the SDK model shape.
    return models as ModelInfo[];
  }

  getCachedModels(): ModelInfo[] | null {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- boundary cast: see listModels above.
    return this.backend.getCachedModels() as ModelInfo[] | null;
  }

  getDefaultModel(): string | undefined {
    const cached = this.backend.getCachedModels();
    if (!cached || cached.length === 0) return undefined;
    const ids = new Map<string, string>();
    for (const m of cached) {
      const id = typeof m.id === "string" ? m.id : "";
      if (id) ids.set(id.toLowerCase(), id);
    }
    for (const preferred of this.preferredDefaultIds) {
      const match = ids.get(preferred);
      if (match) return match;
    }
    // No preferred match — return whichever id is first.
    return ids.values().next().value;
  }
}
