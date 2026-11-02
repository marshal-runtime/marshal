import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_CONNECT_TIMEOUT_MS = 30_000;

export type McpClientConnection =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      type: "http" | "sse";
      url: string;
      accessToken?: string;
      accessTokenOrigin?: string;
    };

export interface ConnectMcpClientOptions {
  clientName: string;
  serverName: string;
  connection: McpClientConnection;
  signal?: AbortSignal;
  onTokenOriginMismatch?: (serverName: string) => void;
}

export function resolveMcpStdioEnvironment(env?: Record<string, string>): Record<string, string> {
  return { ...getDefaultEnvironment(), ...env };
}

export async function connectMcpClient(options: ConnectMcpClientOptions): Promise<Client> {
  const client = new Client({ name: options.clientName, version: "1.0.0" });
  try {
    if (options.connection.type === "stdio") {
      const transport = new StdioClientTransport({
        command: options.connection.command,
        args: options.connection.args ?? [],
        env: resolveMcpStdioEnvironment(options.connection.env),
        ...(options.connection.cwd ? { cwd: options.connection.cwd } : {}),
        stderr: "pipe",
      });
      transport.stderr?.on("data", () => undefined);
      await connectWithTimeout(client, transport, options.signal);
      return client;
    }

    const url = new URL(options.connection.url);
    const headers: Record<string, string> = {};
    if (options.connection.accessToken) {
      const originMatches =
        !options.connection.accessTokenOrigin ||
        url.origin === options.connection.accessTokenOrigin;
      if (originMatches) {
        headers.Authorization = `Bearer ${options.connection.accessToken}`;
      } else {
        options.onTokenOriginMismatch?.(options.serverName);
      }
    }
    const requestInit = { headers };
    const transport =
      options.connection.type === "sse"
        ? new SSEClientTransport(url, { requestInit })
        : new StreamableHTTPClientTransport(url, { requestInit });
    await connectWithTimeout(client, transport, options.signal);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function connectWithTimeout(
  client: Client,
  transport: Parameters<Client["connect"]>[0],
  signal?: AbortSignal,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAborted: ((reason?: unknown) => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`MCP server connection timed out after ${MCP_CONNECT_TIMEOUT_MS}ms`)),
      MCP_CONNECT_TIMEOUT_MS,
    );
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  });
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
  });
  const onAbort = (): void =>
    rejectAborted?.(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([client.connect(transport), timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
