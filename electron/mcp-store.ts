import { EventEmitter } from "events";
import * as fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

import type { McpToolInfo } from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import { mcpErrors, makeMcpError } from "../common/telemetry/errors/marshal-mcp";
import { getAppDataDir } from "./app-paths";
import type { CustomMcpServer } from "./ipc/types";
import { secureMkdir, secureWriteFile, secureWriteFileSync } from "./platform-security";
import {
  type PersistedCustomMcpServer,
  deserializeServer,
  serializeServer,
} from "./platform/extensions/mcp-credential-codec";
import { toMcpServerKey } from "./platform/extensions/mcp-server-key";
import { sendErrorTelemetry } from "./telemetry-errors";

const log = createLogger("McpStore");

// ── Types ──────────────────────────────────────────────────────────────────

interface McpServerEntry {
  builtin: boolean;
  config?: CustomMcpServer;
  tools?: McpToolInfo[];
}

interface McpStoreData {
  servers: Record<string, McpServerEntry>;
}

// ── Zod schema for on-disk validation ──────────────────────────────────────

// Per-server tool-call timeout in ms. Must be a positive safe integer.
// Forwarded to the Copilot SDK (MCPServerConfig.timeout) so long-running tools
// can override the SDK's default ~60s timeout.
const TimeoutSchema = z.number().int().positive().safe().optional();

const RemoteMcpServerSchema = z
  .object({
    name: z.string(),
    url: z.string(),
    type: z.enum(["http", "sse"]).optional(),
    clientId: z.string().optional(),
    tokenEndpoint: z.string().optional(),
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
    tokenExpiry: z.number().optional(),
    accessTokenOrigin: z.string().optional(),
    oauthAlias: z.string().optional(),
    accessTokenEncrypted: z.string().optional(),
    refreshTokenEncrypted: z.string().optional(),
    timeout: TimeoutSchema,
    exposeAsGatewayNodeCommand: z.boolean().optional(),
  })
  .strip();

const CommandMcpServerSchema = z
  .object({
    name: z.string(),
    // Accept both "command" (canonical) and "stdio" (VS Code mcp.json convention);
    // normalize to "command" so downstream narrowing stays single-value.
    type: z.union([z.literal("command"), z.literal("stdio")]).transform(() => "command" as const),
    command: z.string(),
    args: z.array(z.string()).optional(),
    envFile: z.string().optional(),
    timeout: TimeoutSchema,
    exposeAsGatewayNodeCommand: z.boolean().optional(),
  })
  .strip();

export const CustomMcpServerSchema = z.union([CommandMcpServerSchema, RemoteMcpServerSchema]);

const McpServerEntrySchema = z
  .object({
    builtin: z.boolean(),
    config: CustomMcpServerSchema.optional(),
    tools: z.array(z.string()).optional(),
  })
  .strip();

const McpStoreSchema = z.object({
  servers: z.record(z.string(), McpServerEntrySchema),
});

// ── Seed data for built-in servers ─────────────────────────────────────────
// Tools start empty — populated by discoverMcpTools() after session connects.

const BUILTIN_SEED: McpStoreData = {
  servers: {
    filesystem: { builtin: true, tools: [] },
    playwright: { builtin: true, tools: [] },
  },
};

// ── Persistence path ───────────────────────────────────────────────────────

const MCP_STORE_FILENAME = "marshal-mcp-servers.json";

function getStorePath(): string {
  return path.join(getAppDataDir(), MCP_STORE_FILENAME);
}

// ── Persisted shape (tokens encrypted on disk) ─────────────────────────────

interface PersistedMcpServerEntry {
  builtin: boolean;
  config?: PersistedCustomMcpServer;
  tools?: string[];
}

interface PersistedMcpStoreData {
  servers: Record<string, PersistedMcpServerEntry>;
}

// ── McpStore class ─────────────────────────────────────────────────────────

export interface McpRuntimeStatus {
  status: "pending" | "connected" | "failed";
  error?: string;
}

export class McpStore extends EventEmitter {
  private data: McpStoreData;
  private pendingWrite: Promise<void> = Promise.resolve();
  private discoveryInProgress = false;
  private discoveryErrors = new Set<string>();
  private storePath: string;
  private readonly runtimeStatuses = new Map<string, McpRuntimeStatus>();

  constructor(storePath?: string) {
    super();
    this.storePath = storePath ?? getStorePath();
    // Defer the disk read: loadFromDisk() decrypts persisted OAuth tokens via
    // safeStorage, and the first safeStorage access before app.whenReady() locks
    // the macOS keychain item name to "Chromium Safe Storage" (Electron #45328).
    // Start with builtins only (no secrets); reload() performs the read once,
    // post-app-ready (called from main.ts inside app.whenReady()).
    this.data = { servers: {} };
    this.seedBuiltins();
  }

  /**
   * Load persisted servers from disk — decrypting OAuth tokens via safeStorage —
   * and re-seed builtins. Must run after app.whenReady() (see the constructor
   * note re: Electron #45328). Called once at startup from main.ts.
   *
   * Intentionally does NOT emit "changed": this restores persisted state, it is
   * not a user/runtime mutation. Broadcasting here would falsely trip the sync
   * engine's onLocalChange listener (main.ts) into pushing unchanged data at
   * boot. The renderer gets the loaded servers via setCustomMcpServers + IPC.
   */
  reload(): void {
    this.data = this.loadFromDisk();
    this.seedBuiltins();
  }

  /**
   * Full post-`app.whenReady()` startup init, in the required order:
   * `reload()` (load + decrypt from disk) → `migrateFromSettings()` →
   * `pruneStaleOAuthTokens()`. Returns the prepared custom-server list for
   * `mcpStatus.setCustomMcpServers()` / tool discovery. The migrate/prune steps
   * mutate `this.data` in memory, so they MUST run after `reload()` — calling
   * them on a builtins-only store would silently no-op. Encapsulated here so the
   * ordering can't be broken by a `main.ts` reorder. Call once from `main.ts`.
   */
  initPostReady(): CustomMcpServer[] {
    this.reload();
    this.migrateFromSettings();
    this.pruneStaleOAuthTokens();
    return this.getCustomServers();
  }

  /** Get full store contents (tokens decrypted in memory). */
  getAll(): McpStoreData {
    return this.data;
  }

  /** Whether tool discovery is currently running. */
  isDiscoveryInProgress(): boolean {
    return this.discoveryInProgress;
  }

  /** Server keys that failed during the most recent discovery run. */
  getDiscoveryErrors(): ReadonlySet<string> {
    return this.discoveryErrors;
  }

  /** Get only custom (non-builtin) server configs. */
  getCustomServers(): CustomMcpServer[] {
    return Object.values(this.data.servers)
      .filter((entry) => !entry.builtin && entry.config)
      .map((entry) => entry.config!);
  }

  /** Update in-memory runtime status for a server (keyed by display name).
   *  Not persisted — resets on app start along with MCP connections. Emits
   *  "changed" so the renderer refreshes the status indicator. */
  updateRuntimeStatus(displayName: string, status: McpRuntimeStatus | null): void {
    if (status === null) {
      if (!this.runtimeStatuses.has(displayName)) return;
      this.runtimeStatuses.delete(displayName);
    } else {
      const prev = this.runtimeStatuses.get(displayName);
      if (prev && prev.status === status.status && prev.error === status.error) return;
      this.runtimeStatuses.set(displayName, status);
    }
    this.emit("changed");
  }

  getRuntimeStatuses(): ReadonlyMap<string, McpRuntimeStatus> {
    return this.runtimeStatuses;
  }

  /** Add a custom server. Returns the sanitized key. */
  addServer(server: CustomMcpServer): string {
    const key = this.serverKey(server.name);
    this.data.servers[key] = { builtin: false, config: server, tools: [] };
    this.saveToDisk();
    this.emit("changed");
    return key;
  }

  /** Remove a server by name or key. */
  removeServer(name: string): void {
    const key = this.serverKey(name);
    // Try key match first, then look up by config name
    if (this.data.servers[key]) {
      delete this.data.servers[key];
    } else {
      const matchKey = Object.keys(this.data.servers).find(
        (k) => this.data.servers[k].config?.name === name,
      );
      if (matchKey) delete this.data.servers[matchKey];
    }
    this.saveToDisk();
    this.emit("changed");
  }

  /** Update config for an existing custom server. */
  updateServerConfig(name: string, update: Partial<CustomMcpServer>): void {
    const key = this.serverKey(name);
    const entry =
      this.data.servers[key] ??
      Object.values(this.data.servers).find((e) => e.config?.name === name);
    if (!entry?.config) return;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- merging partial update into existing config preserves discriminant
    entry.config = { ...entry.config, ...update } as CustomMcpServer;
    this.saveToDisk();
    this.emit("changed");
  }

  /** Bulk-replace all custom servers (backward compat with setCustomMcpServers). */
  setCustomServers(servers: CustomMcpServer[]): void {
    // Snapshot existing tools before clearing so we don't lose discovery data
    const toolsSnapshot = new Map<string, McpToolInfo[]>();
    for (const [key, entry] of Object.entries(this.data.servers)) {
      if (!entry.builtin && entry.tools?.length) {
        toolsSnapshot.set(key, entry.tools);
      }
    }
    // Remove all non-builtin entries
    for (const key of Object.keys(this.data.servers)) {
      if (!this.data.servers[key].builtin) {
        delete this.data.servers[key];
      }
    }
    // Add new ones, preserving tools from snapshot
    for (const server of servers) {
      const key = this.serverKey(server.name);
      this.data.servers[key] = {
        builtin: false,
        config: server,
        tools: toolsSnapshot.get(key) ?? [],
      };
    }
    this.saveToDisk();
    this.emit("changed");
  }

  /** Persist discovered tool lists for one or more servers. */
  updateToolDiscovery(discoveries: Record<string, { tools: McpToolInfo[] }>): void {
    for (const [key, discovery] of Object.entries(discoveries)) {
      const entry = this.data.servers[key];
      if (entry) {
        entry.tools = discovery.tools;
      }
    }
    this.saveToDisk();
    this.emit("changed");
  }

  /** Record a tool observed from an MCP tool execution event. */
  recordObservedTool(serverName: string, toolName: string): void {
    const name = toolName.trim();
    if (!name) return;

    const key = this.findServerKey(serverName);
    if (!key) return;

    const entry = this.data.servers[key];
    const tools = entry.tools ?? [];
    if (tools.some((tool) => tool.name === name)) return;

    entry.tools = [...tools, { name, description: "Seen in chat" }];
    this.saveToDisk();
    this.emit("changed");
  }

  /**
   * Connect to each stdio-based MCP server and call tools/list to discover available tools.
   * URL-based servers are skipped (they may require OAuth or be unavailable).
   * Fire-and-forget — errors are logged per-server, not thrown.
   */
  async discoverTools(
    mcpConfig: Record<
      string,
      {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        type?: string;
        url?: string;
      }
    >,
  ): Promise<void> {
    if (this.discoveryInProgress) return;
    this.discoveryInProgress = true;
    // Clear all errors upfront — if discoverTools is always called with the full
    // server set this is equivalent to per-server deletion on success.
    this.discoveryErrors.clear();
    this.emit("changed"); // notify renderer so it can show "loading" status
    try {
      const DISCOVERY_TIMEOUT = 15_000;

      // Build list of discoverable servers (stdio only, must be in store)
      const entries = Object.entries(mcpConfig).filter(
        ([key, config]) => !!config.command && !!this.data.servers[key],
      );

      // Discover all servers in parallel
      const results = await Promise.allSettled(
        entries.map(async ([key, config]) => {
          const transport = new StdioClientTransport({
            command: config.command!,
            args: config.args ?? [],
            ...(config.env ? { env: config.env } : {}),
            stderr: "pipe",
          });
          const client = new Client({ name: "marshal-discovery", version: "1.0.0" });
          // Capture child stderr so a hard exit ("Connection closed") surfaces
          // the underlying message (missing binary, bad arg, auth failure, …)
          // instead of being silently dropped.
          const stderrChunks: string[] = [];
          // Track whether connect() succeeded so we can distinguish
          // "unreachable server" (SERVER_CONNECTION_FAILED) from "reached but
          // listTools failed" (TOOL_DISCOVERY_FAILED). The timeout race is
          // attributed to whichever phase was in flight at the deadline.
          let connected = false;
          // Best-effort: attach the stderr listener once the transport stream
          // exists. Polled (not awaited) so a mocked transport that never sets
          // `.stderr` cannot deadlock discovery. Bounded to ~1s of polling.
          let stderrAttached = false;
          let pollsLeft = 100;
          const pollStderr = (): void => {
            if (stderrAttached || pollsLeft-- <= 0) return;
            if (transport.stderr) {
              transport.stderr.on("data", (chunk: Buffer) => {
                stderrChunks.push(chunk.toString("utf-8"));
              });
              stderrAttached = true;
              return;
            }
            setTimeout(pollStderr, 10);
          };
          pollStderr();
          try {
            const toolsResult = await Promise.race([
              (async () => {
                await client.connect(transport);
                connected = true;
                return await client.listTools();
              })(),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), DISCOVERY_TIMEOUT),
              ),
            ]);
            return {
              key,
              tools: toolsResult.tools.map((t) => ({
                name: t.name,
                description: t.description ?? "",
                ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
              })),
            };
          } catch (err) {
            const code = connected
              ? mcpErrors.TOOL_DISCOVERY_FAILED
              : mcpErrors.SERVER_CONNECTION_FAILED;
            sendErrorTelemetry(makeMcpError(code));
            const stderrText = stderrChunks.join("").trim();
            const stderrSummary = stderrText
              ? `stderr: ${stderrText.length} bytes; first line: ${stderrText
                  .split("\n")[0]
                  .replace(/=.+$/g, "=***")}`
              : "";
            log.warn(
              `Tool discovery failed for "${key}":`,
              err instanceof Error ? err.message : err,
              stderrSummary,
            );
            this.discoveryErrors.add(key);
            return null;
          } finally {
            pollsLeft = 0; // stop polling for stderr after discovery resolves
            await client.close().catch(() => {});
          }
        }),
      );

      const discoveries: Record<string, { tools: McpToolInfo[] }> = {};
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          discoveries[result.value.key] = { tools: result.value.tools };
        }
      }

      if (Object.keys(discoveries).length > 0) {
        this.updateToolDiscovery(discoveries);
      }
    } finally {
      this.discoveryInProgress = false;
      this.emit("changed");
    }
  }

  /** One-time migration: reads customMcpServers from the raw marshal-settings.json if the mcp store file doesn't exist yet. */
  migrateFromSettings(): void {
    if (fs.existsSync(this.storePath)) return; // already migrated
    const settingsPath = path.join(path.dirname(this.storePath), "marshal-settings.json");
    if (!fs.existsSync(settingsPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); // SF-4: validated below via array check + deserializeServer
      const rawServers = Array.isArray(raw?.customMcpServers) ? raw.customMcpServers : [];
      if (rawServers.length === 0) return;
      for (const persisted of rawServers) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- raw JSON parsed from settings file, validated by array check above
        const server = deserializeServer(persisted as PersistedCustomMcpServer);
        const key = this.serverKey(server.name);
        this.data.servers[key] = { builtin: false, config: server, tools: [] };
      }
      this.saveToDisk();
      // Clean up: remove customMcpServers from old settings file
      try {
        const settingsData = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); // SF-4: validated by typeof check + "in" operator below
        if (
          settingsData &&
          typeof settingsData === "object" &&
          "customMcpServers" in settingsData
        ) {
          delete settingsData.customMcpServers;
          secureWriteFileSync(settingsPath, JSON.stringify(settingsData, null, 2), { mode: 0o600 });
        }
      } catch {
        // non-fatal — stale key is harmless
      }
    } catch (err) {
      log.warn("Migration from settings failed:", err);
    }
  }

  /** Wait for pending writes (call on before-quit). */
  flush(): Promise<void> {
    return this.pendingWrite;
  }

  /**
   * Strips legacy accessToken/refreshToken/tokenExpiry from servers marked with
   * oauthAlias, which indicates they use SDK-managed OAuth and should not carry
   * manual bearer tokens. Safe to call repeatedly — no-ops if no stale fields
   * are present.
   *
   * Scope: only servers with `oauthAlias` set are pruned. Servers that have
   * tokens but no alias are intentionally left alone — those entries belong to
   * users with a manually configured static bearer token, which the SDK never
   * touches.
   */
  pruneStaleOAuthTokens(): void {
    let changed = false;
    for (const entry of Object.values(this.data.servers)) {
      const config = entry.config;
      if (!config || config.type === "command" || !config.oauthAlias) continue;
      if (
        config.accessToken !== undefined ||
        config.refreshToken !== undefined ||
        config.tokenExpiry !== undefined
      ) {
        delete config.accessToken;
        delete config.refreshToken;
        delete config.tokenExpiry;
        changed = true;
      }
    }
    if (changed) this.saveToDisk();
  }

  // ── Private ────────────────────────────────────────────────────────────

  private seedBuiltins(): void {
    for (const [key, seed] of Object.entries(BUILTIN_SEED.servers)) {
      if (!this.data.servers[key]) {
        this.data.servers[key] = seed;
      }
    }
  }

  private loadFromDisk(): McpStoreData {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = JSON.parse(fs.readFileSync(this.storePath, "utf-8")); // SF-4: validated via McpStoreSchema.safeParse
        const result = McpStoreSchema.safeParse(raw);
        if (!result.success) {
          sendErrorTelemetry(makeMcpError(mcpErrors.CONFIG_INVALID));
          log.warn("Schema validation issues — using defaults:", result.error.format());
          return { servers: {} };
        }
        // Decrypt tokens on custom server configs; restore empty description for tools loaded from disk
        const data: McpStoreData = { servers: {} };
        for (const [key, entry] of Object.entries(result.data.servers)) {
          data.servers[key] = {
            ...entry,
            config: entry.config
              ? deserializeServer(entry.config as PersistedCustomMcpServer)
              : undefined,
            tools: entry.tools?.map((name) => ({ name, description: "" })),
          };
        }
        return data;
      }
    } catch (err) {
      sendErrorTelemetry(makeMcpError(mcpErrors.CONFIG_PARSE_FAILED));
      log.error("Failed to load:", err);
    }
    return { servers: {} };
  }

  private saveToDisk(): void {
    let json: string;
    try {
      const persisted: PersistedMcpStoreData = { servers: {} };
      for (const [key, entry] of Object.entries(this.data.servers)) {
        persisted.servers[key] = {
          ...entry,
          config: entry.config ? serializeServer(entry.config) : undefined,
          tools: entry.tools?.map((t) => t.name),
        };
      }
      json = JSON.stringify(persisted, null, 2);
    } catch (err) {
      log.error("Failed to serialize:", err);
      return;
    }
    const dir = path.dirname(this.storePath);
    this.pendingWrite = this.pendingWrite
      .then(() => secureMkdir(dir, 0o700))
      .then(() => secureWriteFile(this.storePath, json, { mode: 0o600 }))
      .catch((err) => log.error("Failed to save:", err));
  }

  private serverKey(name: string): string {
    return toMcpServerKey(name);
  }

  private findServerKey(name: string): string | undefined {
    const key = this.serverKey(name);
    if (this.data.servers[key]) return key;
    return Object.keys(this.data.servers).find((candidate) => {
      const configName = this.data.servers[candidate].config?.name;
      return configName != null && this.serverKey(configName) === key;
    });
  }
}
