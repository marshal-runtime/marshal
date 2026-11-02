import type {
  GatewayAuthIdentity,
  IpcEventMap,
  IpcHandler,
  IpcInvokeMap,
} from "../../../common/marshal-ipc-contract";
import { roleModeIncludesNode } from "../../../common/marshal-ipc-contract";
import { createLogger } from "../../../common/marshal-logger";
import { toMcpServerKey } from "../../../common/mcp-server-key-normalization";
import type { McpStore } from "../../mcp-store";
import { GatewayNodeBackend, type GatewayNodeBackendConfig } from "./node-backend";
import {
  buildNodeCommandList,
  NodeCommandsBridge,
  type NodeExposedServer,
} from "./node-commands-bridge";
import { GatewayNodeMcpRuntime } from "./node-mcp-runtime";
import { registerGatewayNodeActivityHandlers } from "./node/activity-ipc";
import type { GatewayBackend } from "./provider";

const log = createLogger("GatewayNodeSubsystem");

interface IpcHandle {
  <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>): void;
}

interface BroadcastFn {
  <C extends keyof IpcEventMap>(channel: C, payload: IpcEventMap[C]): void;
}

export interface IpcHandlerDeps {
  ipcHandle: IpcHandle;
  broadcast: BroadcastFn;
}

export interface GatewayNodeSubsystemDeps {
  config: GatewayNodeBackendConfig;
  mcpStore: McpStore;
  acquireGatewayToken?: () => Promise<string | undefined>;
  /**
   * Compatibility seam for runtime wiring owned by main.ts. New composition
   * should pass `acquireGatewayToken`.
   */
  acquireWeaveToken?: () => Promise<string | undefined>;
}

export class GatewayNodeSubsystem {
  private readonly nodeBackend: GatewayNodeBackend;
  private readonly mcpRuntime: GatewayNodeMcpRuntime;
  private readonly bridge: NodeCommandsBridge;
  private readonly mcpStore: McpStore;
  private readonly acquireGatewayToken: () => Promise<string | undefined>;

  constructor(deps: GatewayNodeSubsystemDeps) {
    this.mcpStore = deps.mcpStore;
    const acquireGatewayToken = deps.acquireGatewayToken ?? deps.acquireWeaveToken;
    if (!acquireGatewayToken) {
      throw new Error("GatewayNodeSubsystem requires acquireGatewayToken");
    }
    this.acquireGatewayToken = acquireGatewayToken;

    this.nodeBackend = new GatewayNodeBackend(deps.config);
    this.mcpRuntime = new GatewayNodeMcpRuntime({
      getServers: () =>
        this.mcpStore.getCustomServers().filter((s) => s.exposeAsGatewayNodeCommand === true),
      onToolsDiscovered: (serverName, tools) => {
        this.mcpStore.updateToolDiscovery({
          [toMcpServerKey(serverName)]: { tools },
        });
      },
    });
    this.mcpRuntime.onStatusChange(() => {
      for (const [name, status] of this.mcpRuntime.getStatuses()) {
        this.mcpStore.updateRuntimeStatus(name, status);
      }
    });
    this.bridge = new NodeCommandsBridge({
      log: this.nodeBackend.getActivityLogForBridge(),
      mcpRuntime: this.mcpRuntime,
      getServers: () => this.getExposedServers(),
    });
    this.bridge.attach(this.nodeBackend);
  }

  registerIpcHandlers({ ipcHandle, broadcast }: IpcHandlerDeps): void {
    registerGatewayNodeActivityHandlers({
      ipcHandle,
      broadcast,
      log: this.nodeBackend.getActivityLog(),
    });
  }

  async start(identity: GatewayAuthIdentity, operatorBackend: GatewayBackend): Promise<void> {
    if (!roleModeIncludesNode(identity.roleMode)) {
      if (this.nodeBackend.isConnected()) {
        await this.nodeBackend.stop();
      }
      return;
    }

    const acquireAuthToken = async (): Promise<string | undefined> => {
      if (identity.mode !== "hosted") return undefined;
      try {
        return await this.acquireGatewayToken();
      } catch (err) {
        log.warn("node-side hosted gateway token acquisition failed:", err);
        return undefined;
      }
    };

    const commands = buildNodeCommandList();
    try {
      await this.nodeBackend.start({ cred: identity, acquireAuthToken, commands });
    } catch (err) {
      log.warn("node-side start failed:", err);
      return;
    }

    void this.mcpRuntime
      .preconnectAll()
      .catch((err) => log.warn("gateway MCP preconnect failed:", err));

    const nodeName = identity.nodeName?.trim();
    const nodeId = this.nodeBackend.getDeviceId();
    if (nodeName && nodeId) {
      try {
        await operatorBackend.renameNode(nodeId, nodeName);
        log.info(
          `persisted node displayName (${nodeName.length} chars) via operator-side node.rename`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          `operator-side node.rename failed (displayName ${nodeName.length} chars): ${msg.slice(0, 200)}`,
        );
      }
    }
  }

  async stop(): Promise<void> {
    await this.nodeBackend.stop();
    for (const name of this.mcpRuntime.getStatuses().keys()) {
      this.mcpStore.updateRuntimeStatus(name, null);
    }
    await this.mcpRuntime.reset();
  }

  async dispose(): Promise<void> {
    await this.nodeBackend.stop();
    await this.mcpRuntime.dispose();
  }

  setReconnectingChangeCallback(cb: (v: boolean) => void): void {
    this.nodeBackend.setReconnectingChangeCallback(cb);
  }

  getExposedServers(): ReadonlyArray<NodeExposedServer> {
    const out: NodeExposedServer[] = [];
    for (const entry of Object.values(this.mcpStore.getAll().servers)) {
      if (entry.config?.exposeAsGatewayNodeCommand !== true) continue;
      const name = entry.config.name;
      if (!name) continue;
      out.push({ name, tools: entry.tools ?? [] });
    }
    return out;
  }
}
