// Independent of the SDK: exposes opted-in MCP servers to the gateway-node path.
// preconnectAll (sign-in), reset (sign-out), and dispose (app quit) are distinct.
import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { CustomMcpServer, McpToolInfo } from "../../../common/marshal-ipc-contract";
import { createLogger } from "../../../common/marshal-logger";
import { connectMcpClient, type McpClientConnection } from "../../mcp-client-connector";
import { resolveMcpEnv } from "../../mcp-env";
import type { McpRuntime } from "./desktop-capabilities/execute-mcp-tool";

const log = createLogger("GatewayNodeMcpRuntime");

export interface GatewayMcpServerStatus {
  status: "pending" | "connected" | "failed";
  error?: string;
}

export interface GatewayNodeMcpRuntimeDeps {
  getServers: () => ReadonlyArray<CustomMcpServer>;
  onToolsDiscovered?: (serverName: string, tools: McpToolInfo[]) => void;
}

interface CachedClient {
  client: Client;
  connectionKey: string;
}

interface ConnectingClient {
  connectionKey: string;
  promise?: Promise<Client>;
}

export class GatewayNodeMcpRuntime implements McpRuntime {
  private readonly deps: GatewayNodeMcpRuntimeDeps;
  private readonly clients = new Map<string, CachedClient>();
  private readonly connecting = new Map<string, ConnectingClient>();
  private readonly statuses = new Map<string, GatewayMcpServerStatus>();
  private readonly statusListeners = new Set<() => void>();
  private connectionGeneration = 0;

  constructor(deps: GatewayNodeMcpRuntimeDeps) {
    this.deps = deps;
  }

  hasServer(serverName: string): boolean {
    return this.deps.getServers().some((s) => s.name === serverName);
  }

  async callTool(opts: { serverName: string; toolName: string; args: unknown }): Promise<unknown> {
    const config = this.deps.getServers().find((s) => s.name === opts.serverName);
    if (!config) {
      throw new Error(`MCP server "${opts.serverName}" is not opted into gateway-node exposure`);
    }

    const client = await this.getOrConnect(config);
    const argsObj =
      opts.args !== null && typeof opts.args === "object" && !Array.isArray(opts.args)
        ? // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof+null+!Array guards above; carrying the structural shape forward
          (opts.args as Record<string, unknown>)
        : {};

    try {
      const result = await client.callTool({ name: opts.toolName, arguments: argsObj });
      return result;
    } catch (err) {
      // Drop the cached client so the next call reconnects cold.
      if (this.clients.get(opts.serverName)?.client === client) {
        this.clients.delete(opts.serverName);
      }
      try {
        await client.close();
      } catch {
        // empty
      }
      throw err;
    }
  }

  private disposed = false;

  getStatuses(): ReadonlyMap<string, GatewayMcpServerStatus> {
    return this.statuses;
  }

  onStatusChange(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  async preconnectAll(): Promise<void> {
    if (this.disposed) return;
    const servers = this.deps.getServers();
    if (servers.length === 0) {
      log.info("preconnectAll: no opted-in servers");
      return;
    }
    log.info(`preconnectAll: ${servers.length} opted-in server(s)`);
    await Promise.allSettled(servers.map((s) => this.connectAndDiscover(s)));
  }

  private async connectAndDiscover(config: CustomMcpServer): Promise<void> {
    this.setStatus(config.name, { status: "pending" });
    let client: Client;
    try {
      client = await this.getOrConnect(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`preconnect failed for "${config.name}": ${message}`);
      this.setStatus(config.name, { status: "failed", error: message.slice(0, 200) });
      return;
    }
    try {
      const result = await client.listTools();
      const tools: McpToolInfo[] = result.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
      }));
      this.deps.onToolsDiscovered?.(config.name, tools);
      this.setStatus(config.name, { status: "connected" });
      log.info(`preconnect "${config.name}": ${tools.length} tool(s) discovered`);
    } catch (err) {
      // Reached the server but listTools failed — keep the cached client
      // so a later mcp.invoke can still try, but mark as failed for the
      // UI so the user sees something is wrong with this server.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`listTools failed for "${config.name}": ${message}`);
      this.setStatus(config.name, {
        status: "failed",
        error: `Tool discovery failed: ${message.slice(0, 180)}`,
      });
    }
  }

  private setStatus(serverName: string, status: GatewayMcpServerStatus): void {
    const prev = this.statuses.get(serverName);
    if (prev && prev.status === status.status && prev.error === status.error) return;
    this.statuses.set(serverName, status);
    for (const listener of this.statusListeners) {
      try {
        listener();
      } catch (err) {
        log.warn("status listener threw:", err);
      }
    }
  }

  async reset(): Promise<void> {
    this.connectionGeneration += 1;
    const entries = [...this.clients.entries()];
    this.clients.clear();
    this.connecting.clear();
    const hadStatuses = this.statuses.size > 0;
    this.statuses.clear();
    if (hadStatuses) {
      for (const listener of this.statusListeners) {
        try {
          listener();
        } catch (err) {
          log.warn("status listener threw on reset:", err);
        }
      }
    }
    await Promise.all(
      entries.map(async ([name, { client }]) => {
        try {
          await client.close();
        } catch (err) {
          log.warn(`failed to close MCP client "${name}" during reset:`, err);
        }
      }),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.connectionGeneration += 1;
    const entries = [...this.clients.entries()];
    this.clients.clear();
    this.connecting.clear();
    this.statuses.clear();
    this.statusListeners.clear();
    await Promise.all(
      entries.map(async ([name, { client }]) => {
        try {
          await client.close();
        } catch (err) {
          log.warn(`failed to close MCP client "${name}":`, err);
        }
      }),
    );
  }

  private async getOrConnect(config: CustomMcpServer): Promise<Client> {
    if (this.disposed) throw new Error(`GatewayNodeMcpRuntime is disposed`);
    const connection = resolveConnection(config);
    const connectionKey = hashConnection(connection);
    const existing = this.clients.get(config.name);
    if (existing?.connectionKey === connectionKey) return existing.client;
    if (existing) {
      this.clients.delete(config.name);
      await existing.client.close().catch((err: unknown) => {
        log.warn(`failed to close stale MCP client "${config.name}":`, err);
      });
    }
    const inFlight = this.connecting.get(config.name);
    if (inFlight?.connectionKey === connectionKey && inFlight.promise) return inFlight.promise;
    if (inFlight) this.connecting.delete(config.name);

    const generation = this.connectionGeneration;
    const connecting: ConnectingClient = { connectionKey };
    const connectPromise = this.openClient(config.name, connection)
      .then((client) => {
        if (
          this.disposed ||
          generation !== this.connectionGeneration ||
          this.connecting.get(config.name) !== connecting
        ) {
          void client.close().catch(() => undefined);
          throw new Error(
            this.disposed
              ? `GatewayNodeMcpRuntime disposed during connect`
              : generation !== this.connectionGeneration
                ? `GatewayNodeMcpRuntime reset during connect`
                : `GatewayNodeMcpRuntime configuration changed during connect`,
          );
        }
        this.clients.set(config.name, { client, connectionKey });
        // Mark connected here so the lazy ``callTool``-driven path also
        // updates the UI status (preconnectAll uses connectAndDiscover,
        // which then overwrites with a more informed status after it
        // runs ``listTools``). Without this, a server added after sign-
        // in would stay "pending" in Settings even after a successful
        // first invoke.
        this.setStatus(config.name, { status: "connected" });
        log.info(`connected to MCP server "${config.name}"`);
        return client;
      })
      .finally(() => {
        if (this.connecting.get(config.name) === connecting) {
          this.connecting.delete(config.name);
        }
      });
    connecting.promise = connectPromise;
    this.connecting.set(config.name, connecting);
    return connectPromise;
  }

  private async openClient(serverName: string, connection: McpClientConnection): Promise<Client> {
    return connectMcpClient({
      // Marshal identity: the Gateway signs and records this client identifier.
      clientName: "marshal-gateway-node",
      serverName,
      connection,
      onTokenOriginMismatch: (name) =>
        log.warn(`MCP server "${name}": dropping bearer token -- origin mismatch.`),
    });
  }
}

function resolveConnection(config: CustomMcpServer): McpClientConnection {
  if ("type" in config && config.type === "command") {
    const env = resolveMcpEnv(config);
    return {
      type: "stdio",
      command: config.command,
      args: config.args ?? [],
      ...(env ? { env } : {}),
    };
  }
  if (!("url" in config) || !config.url) {
    throw new Error(`MCP server "${config.name}" has neither command nor URL`);
  }
  return {
    type: config.type === "sse" ? "sse" : "http",
    url: config.url,
    ...(config.accessToken ? { accessToken: config.accessToken } : {}),
    ...(config.accessTokenOrigin ? { accessTokenOrigin: config.accessTokenOrigin } : {}),
  };
}

function hashConnection(connection: McpClientConnection): string {
  const canonical =
    connection.type === "stdio"
      ? {
          ...connection,
          env: Object.fromEntries(
            Object.entries(connection.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
          ),
        }
      : connection;
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
