import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MarshalRuntimeBrowserCommandRequest } from "./browser-command-executor";
import {
  PlaywrightMcpBrowserCommandExecutor,
  type PlaywrightMcpBrowserCommandExecutorOptions,
} from "./playwright-mcp-browser-executor";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Playwright MCP browser executor", () => {
  it("uses real MCP protocol clients, isolates sessions, and preserves result artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "marshal-playwright-executor-test-"));
    tempDirectories.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const servers: Server[] = [];
    const callArguments: unknown[] = [];
    const connectClient = vi.fn<
      NonNullable<PlaywrightMcpBrowserCommandExecutorOptions["connectClient"]>
    >(async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: "playwright-test", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "browser_take_screenshot",
            description: "Take a screenshot",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (callRequest) => {
        callArguments.push(callRequest.params);
        return {
          content: [
            { type: "text", text: "external browser text" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
            {
              type: "resource",
              resource: {
                uri: "file:///page.txt",
                mimeType: "text/plain",
                text: "external artifact text",
              },
            },
          ],
          structuredContent: { artifact: { path: "page.png" } },
        };
      });
      await server.connect(serverTransport);
      const client = new Client({ name: "marshal-browser-test", version: "1.0.0" });
      await client.connect(clientTransport);
      servers.push(server);
      return client;
    });
    const executor = new PlaywrightMcpBrowserCommandExecutor({
      isPackaged: false,
      appPath: REPOSITORY_ROOT,
      resourcesPath: REPOSITORY_ROOT,
      appDataRoot: root,
      getInterceptFileChooser: () => false,
      getBlockedOrigins: () => ["https://blocked.example"],
      connectClient,
    });

    const first = request(workspace, "browser-session-1");
    const result = await executor.execute(first);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      content: expect.arrayContaining([
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        {
          type: "resource",
          resource: {
            uri: "file:///page.txt",
            mimeType: "text/plain",
            text: expect.stringContaining('<external_content source="mcp">'),
          },
        },
        {
          type: "text",
          text: expect.stringContaining('"artifact":{"path":"page.png"}'),
        },
      ]),
    });
    expect(result.data).not.toHaveProperty("structuredContent");
    expect(callArguments[0]).toEqual({
      name: "browser_take_screenshot",
      arguments: { type: "png", fullPage: true },
    });
    const firstConnection = connectClient.mock.calls[0]?.[0];
    const connectionArgs =
      firstConnection?.connection.type === "stdio" ? firstConnection.connection.args : undefined;
    const configArgumentIndex = connectionArgs?.indexOf("--config") ?? -1;
    expect(configArgumentIndex).toBeGreaterThanOrEqual(0);
    if (!connectionArgs || configArgumentIndex < 0) {
      throw new Error("Expected a Playwright MCP config argument");
    }
    const configPath = connectionArgs[configArgumentIndex + 1];
    if (!configPath) throw new Error("Expected a Playwright MCP config path");
    const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (config === null || typeof config !== "object") {
      throw new Error("Expected the Playwright MCP config to be an object");
    }
    const browser: unknown = Reflect.get(config, "browser");
    if (browser === null || typeof browser !== "object") {
      throw new Error("Expected the Playwright MCP browser config to be an object");
    }
    expect(Reflect.get(browser, "userDataDir")).toContain("browser-profile");

    await executor.execute(first);
    expect(connectClient).toHaveBeenCalledOnce();
    await executor.execute(request(workspace, "browser-session-2"));
    expect(connectClient).toHaveBeenCalledTimes(2);
    await expect(
      executor.execute({
        ...first,
        scope: { ...first.scope, workspaceName: "other-workspace" },
      }),
    ).rejects.toThrow("cannot change Marshal Runtime scope");

    await executor.dispose();
    await executor.execute(request(workspace, "browser-session-3"));
    expect(connectClient).toHaveBeenCalledTimes(3);
    await executor.dispose();
    await Promise.all(servers.map((server) => server.close()));
  });
});

function request(
  workspacePath: string,
  browserSessionId: string,
): MarshalRuntimeBrowserCommandRequest {
  return {
    command: "browser_screenshot",
    input: { format: "png", fullPage: true },
    context: {
      chatId: "session-1",
      executionId: "execution-1",
      browserSessionId,
    },
    scope: {
      sessionId: "session-1",
      workspaceName: "workspace-1",
      workspacePath,
    },
  };
}
