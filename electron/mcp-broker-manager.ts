import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createLogger } from "../common/marshal-logger";
import type {
  RuntimeMcpHttpServerConfig,
  RuntimeMcpServerConfig,
  RuntimeMcpStdioServerConfig,
} from "./backend/runtime-contract";
import {
  McpBrokerCore,
  type McpBrokerCapability,
  type McpBrokerInvocationRecord,
  type McpBrokerUpstream,
  type McpBrokerUpstreamConfig,
  type McpBrokerUpstreamFactory,
} from "./mcp-broker-core";
import { connectMcpClient, resolveMcpStdioEnvironment } from "./mcp-client-connector";
import { wrapUntrusted } from "./untrusted-wrap";

const log = createLogger("McpBrokerManager");
const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface McpBrokerSessionConfigOptions {
  sessionId: string;
  mcpServers: Readonly<Record<string, RuntimeMcpServerConfig>>;
  workspaceDir: string;
  identityKey: string;
  configGeneration: number;
  isServerEnabled: (serverKey: string) => boolean;
}

interface SessionCapability {
  capability: McpBrokerCapability;
  allowedTools?: ReadonlySet<string>;
}

export interface AppMcpBrokerManagerOptions {
  createUpstream?: McpBrokerUpstreamFactory;
  maxBodyBytes?: number;
  maxOutputBytes?: number;
  maxConcurrencyPerUpstream?: number;
  onInvocation?: (record: McpBrokerInvocationRecord) => void;
}

export class AppMcpBrokerManager {
  private readonly core: McpBrokerCore;
  private readonly maxBodyBytes: number;
  private readonly maxOutputBytes: number;
  private readonly capabilitiesById = new Map<string, SessionCapability>();
  private readonly capabilitiesBySession = new Map<string, McpBrokerCapability[]>();
  private readonly sessionOperations = new Map<string, symbol>();
  private httpServer: ReturnType<typeof createServer> | null = null;
  private listenPromise: Promise<number> | null = null;
  private port: number | null = null;
  private disposed = false;

  constructor(options: AppMcpBrokerManagerOptions = {}) {
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.core = new McpBrokerCore({
      createUpstream: options.createUpstream ?? createStdioUpstream,
      ...(options.maxConcurrencyPerUpstream === undefined
        ? {}
        : { maxConcurrencyPerUpstream: options.maxConcurrencyPerUpstream }),
      maxOutputBytes: this.maxOutputBytes,
      ...(options.onInvocation ? { onInvocation: options.onInvocation } : {}),
    });
  }

  async prepareSessionConfig(
    options: McpBrokerSessionConfigOptions,
  ): Promise<Record<string, RuntimeMcpServerConfig>> {
    if (this.disposed) throw new Error("MCP broker manager is disposed");
    const operation = Symbol(options.sessionId);
    this.sessionOperations.set(options.sessionId, operation);
    await this.retireSessionCapabilities(options.sessionId);
    this.assertCurrentSessionOperation(options.sessionId, operation);

    const result: Record<string, RuntimeMcpServerConfig> = {};
    const capabilities: McpBrokerCapability[] = [];
    try {
      for (const [serverKey, config] of Object.entries(options.mcpServers)) {
        if (!options.isServerEnabled(serverKey)) continue;
        if (!isStdioConfig(config)) {
          result[serverKey] = config;
          continue;
        }

        const capability = this.core.createCapability({
          sessionId: options.sessionId,
          serverKey,
          config: toUpstreamConfig(config, options),
          isEnabled: () => options.isServerEnabled(serverKey),
        });
        capabilities.push(capability);
        this.capabilitiesById.set(capability.id, {
          capability,
          allowedTools: toAllowedTools(config.tools),
        });
      }

      if (capabilities.length === 0) {
        if (this.sessionOperations.get(options.sessionId) === operation) {
          this.sessionOperations.delete(options.sessionId);
        }
        return result;
      }

      this.capabilitiesBySession.set(options.sessionId, capabilities);
      const port = await this.ensureListening();
      this.assertCurrentSessionOperation(options.sessionId, operation);
      for (const capability of capabilities) {
        const original = options.mcpServers[capability.serverKey];
        result[capability.serverKey] = {
          type: "http",
          url: `http://${LOOPBACK_HOST}:${port}/mcp/${capability.id}`,
          headers: { Authorization: `Bearer ${capability.token}` },
          ...(original?.tools === undefined ? {} : { tools: original.tools }),
          ...(original?.timeout === undefined ? {} : { timeout: original.timeout }),
        } satisfies RuntimeMcpHttpServerConfig;
      }
      return result;
    } catch (error) {
      if (this.capabilitiesBySession.get(options.sessionId) === capabilities) {
        this.capabilitiesBySession.delete(options.sessionId);
      }
      await Promise.allSettled(capabilities.map((capability) => capability.revoke()));
      for (const capability of capabilities) this.capabilitiesById.delete(capability.id);
      throw error;
    }
  }

  async releaseSession(sessionId: string): Promise<void> {
    const operation = Symbol(sessionId);
    this.sessionOperations.set(sessionId, operation);
    await this.retireSessionCapabilities(sessionId);
    if (this.sessionOperations.get(sessionId) === operation) {
      this.sessionOperations.delete(sessionId);
    }
  }

  private async retireSessionCapabilities(sessionId: string): Promise<void> {
    const capabilities = this.capabilitiesBySession.get(sessionId);
    if (!capabilities) return;
    this.capabilitiesBySession.delete(sessionId);
    for (const capability of capabilities) this.capabilitiesById.delete(capability.id);
    await Promise.allSettled(capabilities.map((capability) => capability.revoke()));
  }

  private assertCurrentSessionOperation(sessionId: string, operation: symbol): void {
    if (this.disposed) throw new Error("MCP broker manager is disposed");
    if (this.sessionOperations.get(sessionId) !== operation) {
      throw new Error(`MCP session preparation superseded for ${sessionId}`);
    }
  }

  async revokeAll(): Promise<void> {
    await Promise.all(
      [...this.capabilitiesBySession.keys()].map((sessionId) => this.releaseSession(sessionId)),
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.capabilitiesById.clear();
    this.capabilitiesBySession.clear();
    this.sessionOperations.clear();
    await this.core.dispose();
    await this.listenPromise?.catch(() => undefined);
    const server = this.httpServer;
    this.httpServer = null;
    this.listenPromise = null;
    this.port = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private async ensureListening(): Promise<number> {
    if (this.port !== null) return this.port;
    if (this.listenPromise) return this.listenPromise;
    this.listenPromise = new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response).catch((error: unknown) => {
          log.warn("Loopback MCP facade request failed", {
            method: request.method,
            error: error instanceof Error ? error.name : "unknown",
          });
          if (error instanceof HttpBodyTooLargeError) {
            sendJsonError(response, 413, error.message);
          } else if (error instanceof SyntaxError) {
            sendJsonError(response, 400, "Invalid MCP request JSON");
          } else {
            sendJsonError(response, 500, "Internal MCP facade error");
          }
        });
      });
      server.maxConnections = 256;
      server.requestTimeout = 30_000;
      server.headersTimeout = 10_000;
      server.once("error", reject);
      server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
        server.off("error", reject);
        if (this.disposed) {
          server.close();
          reject(new Error("MCP broker manager disposed while opening loopback listener"));
          return;
        }
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("MCP broker failed to acquire a loopback address"));
          return;
        }
        this.httpServer = server;
        this.port = address.port;
        server.unref();
        resolve(address.port);
      });
    }).finally(() => {
      if (this.port === null) this.listenPromise = null;
    });
    return this.listenPromise;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const allowedHost = this.port === null ? "" : `${LOOPBACK_HOST}:${this.port}`;
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendJsonError(response, 403, "Loopback access required");
      return;
    }
    if (request.headers.host !== allowedHost) {
      sendJsonError(response, 421, "Invalid MCP facade host");
      return;
    }
    if (request.headers.origin !== undefined) {
      sendJsonError(response, 403, "Browser origins are not accepted");
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJsonError(response, 405, "Method not allowed");
      return;
    }

    const url = new URL(request.url ?? "/", `http://${allowedHost}`);
    const match = /^\/mcp\/([a-f0-9]{32})$/.exec(url.pathname);
    if (!match || url.search.length > 0) {
      sendJsonError(response, 404, "MCP capability not found");
      return;
    }
    const sessionCapability = this.capabilitiesById.get(match[1]);
    if (
      !sessionCapability ||
      !hasValidBearer(request.headers.authorization, sessionCapability.capability.token)
    ) {
      sendJsonError(response, 401, "Invalid MCP capability");
      return;
    }

    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxBodyBytes) {
      sendJsonError(response, 413, "MCP request body too large");
      return;
    }
    const parsedBody = await readJsonBody(request, this.maxBodyBytes);
    const protocolServer = createFacadeProtocolServer(sessionCapability, this.maxOutputBytes);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      allowedHosts: [allowedHost],
      allowedOrigins: [],
      enableDnsRebindingProtection: true,
    });
    try {
      await protocolServer.connect(transport);
      await transport.handleRequest(request, response, parsedBody);
    } finally {
      await protocolServer.close().catch(() => undefined);
    }
  }
}

function createFacadeProtocolServer(
  sessionCapability: SessionCapability,
  maxOutputBytes: number,
): McpProtocolServer {
  const { capability, allowedTools } = sessionCapability;
  const server = new McpProtocolServer(
    { name: "marshal-mcp-facade", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    let result: ReturnType<typeof ListToolsResultSchema.parse>;
    try {
      result = ListToolsResultSchema.parse(await capability.listTools(extra.signal));
    } catch (error) {
      throw wrapMcpError(capability.serverKey, error, extra.signal, maxOutputBytes);
    }
    const filtered = allowedTools
      ? { ...result, tools: result.tools.filter((tool) => allowedTools.has(tool.name)) }
      : result;
    assertOutputSize(filtered, maxOutputBytes);
    return filtered;
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (allowedTools && !allowedTools.has(request.params.name)) {
      throw new Error(`MCP tool "${request.params.name}" is not allowed for this session`);
    }
    let result: ReturnType<typeof CallToolResultSchema.parse>;
    try {
      result = CallToolResultSchema.parse(
        await capability.callTool(
          request.params.name,
          request.params.arguments ?? {},
          extra.signal,
        ),
      );
    } catch (error) {
      throw wrapMcpError(capability.serverKey, error, extra.signal, maxOutputBytes);
    }
    const wrapped = wrapMcpToolResult(capability.serverKey, result);
    assertOutputSize(wrapped, maxOutputBytes);
    return wrapped;
  });
  return server;
}

function toAllowedTools(tools: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (tools === undefined || tools.includes("*")) return undefined;
  return new Set(tools);
}

function wrapMcpToolResult(
  serverKey: string,
  result: ReturnType<typeof CallToolResultSchema.parse>,
): ReturnType<typeof CallToolResultSchema.parse> {
  const content = result.content.map((block) => {
    if (block.type === "text") {
      return { ...block, text: wrapMcpText(serverKey, block.text) };
    }
    if (block.type === "resource" && "text" in block.resource) {
      return {
        ...block,
        resource: { ...block.resource, text: wrapMcpText(serverKey, block.resource.text) },
      };
    }
    return block;
  });
  if (result.structuredContent === undefined) return { ...result, content };

  const copy = { ...result, content };
  delete copy.structuredContent;
  copy.content = [
    ...content,
    {
      type: "text",
      text: wrapMcpText(serverKey, JSON.stringify(result.structuredContent)),
    },
  ];
  return copy;
}

function wrapMcpText(serverKey: string, text: string): string {
  return wrapUntrusted("mcp", `MCP server: ${serverKey}\n${text}`);
}

function wrapMcpError(
  serverKey: string,
  error: unknown,
  signal: AbortSignal,
  maxOutputBytes: number,
): Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  if (signal.aborted) {
    if (error instanceof Error) return error;
    if (signal.reason instanceof Error) return signal.reason;
    return new DOMException("Aborted", "AbortError");
  }
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = wrapMcpText(serverKey, message);
  assertOutputSize(wrapped, maxOutputBytes);
  return new Error(wrapped);
}

function toUpstreamConfig(
  config: RuntimeMcpStdioServerConfig,
  options: McpBrokerSessionConfigOptions,
): McpBrokerUpstreamConfig {
  const workingDirectory = config.workingDirectory ?? options.workspaceDir;
  return {
    command: config.command,
    args: config.args ?? [],
    env: resolveMcpStdioEnvironment(config.env),
    workingDirectory,
    workspaceDir: options.workspaceDir,
    identityKey: options.identityKey,
    configGeneration: options.configGeneration,
  };
}

function isStdioConfig(config: RuntimeMcpServerConfig): config is RuntimeMcpStdioServerConfig {
  return "command" in config;
}

async function createStdioUpstream(
  config: McpBrokerUpstreamConfig,
  signal?: AbortSignal,
): Promise<McpBrokerUpstream> {
  const client = await connectMcpClient({
    clientName: "marshal-mcp-broker",
    serverName: "broker-upstream",
    connection: {
      type: "stdio",
      command: config.command,
      args: config.args,
      ...(config.env ? { env: config.env } : {}),
      cwd: config.workingDirectory,
    },
    signal,
  });
  return {
    listTools: (requestSignal) => client.listTools(undefined, { signal: requestSignal }),
    callTool: (toolName, args, requestSignal) =>
      client.callTool({ name: toolName, arguments: args }, undefined, { signal: requestSignal }),
    close: () => client.close(),
  };
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new HttpBodyTooLargeError();
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) throw new SyntaxError("Empty MCP request body");
  return JSON.parse(body) as unknown;
}

function hasValidBearer(value: string | undefined, token: string): boolean {
  if (!value) return false;
  const actual = Buffer.from(value, "utf8");
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === LOOPBACK_HOST || address === "::1" || address === "::ffff:127.0.0.1";
}

function assertOutputSize(result: unknown, maxBytes: number): void {
  const serialized = JSON.stringify(result);
  if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(`MCP facade response exceeded ${maxBytes} bytes`);
  }
}

function sendJsonError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32_603, message }, id: null }));
}

class HttpBodyTooLargeError extends Error {
  constructor() {
    super("MCP request body too large");
    this.name = "HttpBodyTooLargeError";
  }
}
