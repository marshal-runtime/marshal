import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { RuntimeMcpStdioServerConfig } from "../backend/runtime-contract";
import { connectMcpClient } from "../mcp-client-connector";
import { buildMcpConfig } from "../mcp-tools";
import { secureMkdirSync, secureWriteFileSync } from "../platform-security";
import { buildPlaywrightEgressConfig } from "../platform/browser-egress-config";
import { wrapUntrusted } from "../untrusted-wrap";
import { adaptMarshalBrowserCommand } from "./browser-command-adapters";
import type {
  MarshalRuntimeBrowserCommandExecutorPort,
  MarshalRuntimeBrowserCommandRequest,
  MarshalRuntimeBrowserCommandResult,
} from "./browser-command-executor";

interface BrowserClient {
  readonly client: Client;
  readonly scopeKey: string;
  readonly tools: ReadonlySet<string>;
}

export interface PlaywrightMcpBrowserCommandExecutorOptions {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly appDataRoot: string;
  readonly getInterceptFileChooser: () => boolean;
  readonly getBlockedOrigins: () => readonly string[];
  readonly timeoutMs?: number;
  readonly connectClient?: typeof connectMcpClient;
}

export class PlaywrightMcpBrowserCommandExecutor implements MarshalRuntimeBrowserCommandExecutorPort {
  private readonly clients = new Map<
    string,
    { scopeKey: string; client: Promise<BrowserClient> }
  >();

  constructor(private readonly options: PlaywrightMcpBrowserCommandExecutorOptions) {}

  async execute(
    request: MarshalRuntimeBrowserCommandRequest,
  ): Promise<MarshalRuntimeBrowserCommandResult> {
    const startedAt = Date.now();
    const adapted = adaptMarshalBrowserCommand(request.command, request.input);
    const browserClient = await this.clientFor(request);
    if (!browserClient.tools.has(adapted.toolName)) {
      throw new Error(`The installed Playwright MCP does not provide ${adapted.toolName}.`);
    }
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await browserClient.client.callTool(
        { name: adapted.toolName, arguments: adapted.input },
        undefined,
        { signal },
      );
    } catch (error) {
      await this.retire(request.context.browserSessionId, browserClient);
      throw new Error("Playwright MCP browser command execution failed.", { cause: error });
    }
    const wrapped = wrapMcpToolResult(result);
    const metadata = {
      duration: Date.now() - startedAt,
      timestamp: Date.now(),
      commandId: randomUUID(),
      context: request.context,
    };
    return result.isError
      ? {
          success: false,
          error: {
            code: "PLAYWRIGHT_MCP_TOOL_ERROR",
            message: "Playwright MCP reported a browser command error.",
            details: wrapped,
          },
          metadata,
        }
      : { success: true, data: wrapped, metadata };
  }

  async dispose(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    const results = await Promise.allSettled(
      clients.map(async ({ client }) => (await client).client.close()),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to dispose Playwright MCP browser sessions.");
    }
  }

  private clientFor(request: MarshalRuntimeBrowserCommandRequest): Promise<BrowserClient> {
    const scopeKey = `${request.scope.sessionId}\0${request.scope.workspaceName}\0${request.scope.workspacePath}`;
    const existing = this.clients.get(request.context.browserSessionId);
    if (existing) {
      if (existing.scopeKey !== scopeKey) {
        throw new Error("A Playwright MCP browser session cannot change Marshal Runtime scope.");
      }
      return existing.client;
    }
    const client = this.connect(request, scopeKey);
    this.clients.set(request.context.browserSessionId, { scopeKey, client });
    void client.catch(() => {
      if (this.clients.get(request.context.browserSessionId)?.client === client) {
        this.clients.delete(request.context.browserSessionId);
      }
    });
    return client;
  }

  private async connect(
    request: MarshalRuntimeBrowserCommandRequest,
    scopeKey: string,
  ): Promise<BrowserClient> {
    const sessionKey = createHash("sha256")
      .update(request.scope.sessionId)
      .update("\0")
      .update(request.scope.workspaceName)
      .digest("hex")
      .slice(0, 32);
    const outputDirectory = path.join(
      this.options.appDataRoot,
      "browser-output",
      "marshal-runtime",
      sessionKey,
    );
    secureMkdirSync(outputDirectory, 0o700);
    const initScriptPath = this.options.isPackaged
      ? path.join(this.options.resourcesPath, "marshal-playwright-init-egress-block.js")
      : path.join(this.options.appPath, "resources", "marshal-playwright-init-egress-block.js");
    const configPath = path.join(outputDirectory, "playwright-mcp-config.json");
    const userDataDirectory = path.join(outputDirectory, "browser-profile");
    secureMkdirSync(userDataDirectory, 0o700);
    secureWriteFileSync(
      configPath,
      JSON.stringify(
        buildPlaywrightEgressConfig(
          initScriptPath,
          [...this.options.getBlockedOrigins()],
          userDataDirectory,
        ),
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );
    const configuration = buildMcpConfig(
      request.scope.workspacePath,
      [],
      this.options.isPackaged,
      this.options.getInterceptFileChooser(),
      false,
      request.scope.workspacePath,
      outputDirectory,
      configPath,
    ).playwright;
    if (!configuration || !("command" in configuration)) {
      throw new Error("The Playwright MCP stdio configuration is unavailable.");
    }
    const stdio = configuration satisfies RuntimeMcpStdioServerConfig;
    const client = await (this.options.connectClient ?? connectMcpClient)({
      clientName: "marshal-runtime-agentic-browser",
      serverName: "playwright",
      connection: {
        type: "stdio",
        command: stdio.command,
        args: stdio.args,
        env: stdio.env,
        cwd: request.scope.workspacePath,
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });
    try {
      const inventory = await client.listTools(undefined, {
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return {
        client,
        scopeKey,
        tools: new Set(inventory.tools.map((tool) => tool.name)),
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new Error("Playwright MCP browser tool discovery failed.", { cause: error });
    }
  }

  private async retire(browserSessionId: string, client: BrowserClient): Promise<void> {
    const current = this.clients.get(browserSessionId);
    if (current && (await current.client) === client) this.clients.delete(browserSessionId);
    await client.client.close().catch(() => undefined);
  }
}

function wrapMcpToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Awaited<ReturnType<Client["callTool"]>> {
  if (!Array.isArray(result.content)) return result;
  const content = result.content.map((block) => {
    if (!isRecord(block)) return block;
    if (block.type === "text" && typeof block.text === "string") {
      return { ...block, text: wrapMcpText(block.text) };
    }
    if (
      block.type === "resource" &&
      isRecord(block.resource) &&
      typeof block.resource.text === "string"
    ) {
      return {
        ...block,
        resource: { ...block.resource, text: wrapMcpText(block.resource.text) },
      };
    }
    return block;
  });
  const { structuredContent, ...unstructured } = result;
  return structuredContent === undefined
    ? { ...unstructured, content }
    : {
        ...unstructured,
        content: [
          ...content,
          { type: "text", text: wrapMcpText(JSON.stringify(structuredContent)) },
        ],
      };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wrapMcpText(text: string): string {
  return wrapUntrusted("mcp", `MCP server: playwright\n${text}`);
}
