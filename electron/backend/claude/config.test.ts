import type {
  McpSdkServerConfigWithInstance,
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../testing/harness/test-double";
import { toClaudeQueryOptions } from "./config";
import { DEFAULT_CLAUDE_CONFIG_DIR } from "./environment";
import { CLAUDE_MCP_OAUTH_UNSUPPORTED_MESSAGE, toClaudeMcpServers } from "./mcp-config";
import { ClaudeToolInvocationRegistry } from "./tool-invocations";

function options(
  config: Parameters<typeof toClaudeQueryOptions>[0]["config"],
  overrides: Partial<Parameters<typeof toClaudeQueryOptions>[0]> = {},
) {
  return toClaudeQueryOptions({
    client: {
      workspaceDir: String.raw`C:\workspace`,
      env: {
        PATH: "bin",
        NODE_OPTIONS: "--require payload.js",
        ELECTRON_RUN_AS_NODE: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
        CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
        CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "7",
        claude_code_oauth_token_mixed_case: "mixed-oauth-token",
        GH_TOKEN: "github-token",
        node_options: "--require mixed-case-payload.js",
        git_askpass: "mixed-case-askpass",
        GIT_EXTERNAL_DIFF: "evil-diff",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "alias.status",
        GIT_CONFIG_VALUE_0: "!payload",
      },
    },
    config,
    sessionId: "11111111-1111-4111-8111-111111111111",
    resume: false,
    toolAliases: {},
    invocations: new ClaudeToolInvocationRegistry(),
    ...overrides,
  });
}

describe("toClaudeQueryOptions", () => {
  it("uses the Claude Code preset with Marshal content appended and project settings", () => {
    const result = options({
      clientName: "marshal/1.0.0",
      model: "claude-sonnet-5",
      reasoningEffort: "xhigh",
      contextTier: "long_context",
      streaming: true,
      includeSubAgentStreamingEvents: true,
      systemMessage: { content: "Marshal system instructions" },
    });

    expect(result).toMatchObject({
      cwd: String.raw`C:\workspace`,
      settingSources: ["project"],
      skills: "all",
      strictMcpConfig: true,
      persistSession: true,
      tools: { type: "preset", preset: "claude_code" },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "Marshal system instructions",
      },
      model: "claude-sonnet-5",
      effort: "xhigh",
      betas: ["context-1m-2025-08-07"],
      includePartialMessages: true,
      forwardSubagentText: true,
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result.env).toMatchObject({
      PATH: "bin",
      CLAUDE_CONFIG_DIR: DEFAULT_CLAUDE_CONFIG_DIR,
      CLAUDE_AGENT_SDK_CLIENT_APP: "marshal/1.0.0",
    });
    expect(result.env?.NODE_OPTIONS).toBeUndefined();
    expect(result.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(result.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(result.env?.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH).toBeUndefined();
    expect(result.env?.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR).toBeUndefined();
    expect(result.env?.claude_code_oauth_token_mixed_case).toBeUndefined();
    expect(result.env?.GH_TOKEN).toBeUndefined();
    expect(result.env?.node_options).toBeUndefined();
    expect(result.env?.git_askpass).toBeUndefined();
    expect(result.env?.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(result.env?.GIT_PAGER).toBe("");
    expect(result.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(result.env?.GIT_CONFIG_VALUE_0).not.toBe("!payload");
  });

  it("turns off Claude Code auto-memory for every session, with or without project context", () => {
    expect(options({}).settings).toMatchObject({ autoMemoryEnabled: false });
    expect(options({ projectContext: false }).settings).toMatchObject({
      autoMemoryEnabled: false,
    });
  });

  it("requests thinking summaries so long thinking streams visible reasoning", () => {
    expect(options({}).thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("only replaces the Claude system prompt when the runtime explicitly requests it", () => {
    const result = options({
      systemMessage: { content: "fully custom", mode: "replace" },
    });

    expect(result.systemPrompt).toBe("fully custom");
  });

  it("replace mode holds identically on resume and leaves the tools preset untouched", () => {
    const created = options({
      systemMessage: { content: "marshal replacement prompt", mode: "replace" },
    });
    const resumed = options(
      { systemMessage: { content: "marshal replacement prompt", mode: "replace" } },
      { resume: true },
    );
    // Full custom string on both paths — a resumed replacement session must
    // never silently fall back to preset+append.
    expect(created.systemPrompt).toBe("marshal replacement prompt");
    expect(resumed.systemPrompt).toBe("marshal replacement prompt");
    expect(resumed.resume).toBe("11111111-1111-4111-8111-111111111111");
    // The native tool surface is governed by the tools option independently
    // of the prompt mode.
    expect(created.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(resumed.tools).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("forwards normalized repository agents to Claude", () => {
    const result = options({
      agents: {
        reviewer: { description: "Reviews changes", prompt: "Review carefully." },
      },
    });

    expect(result.agents).toEqual({
      reviewer: { description: "Reviews changes", prompt: "Review carefully." },
    });
  });

  it("removes every callable tool surface for an empty availableTools allowlist", () => {
    const hostServer = testDouble<McpSdkServerConfigWithInstance>({
      type: "sdk",
      name: "Marshal host tools",
      instance: testDouble({}),
    });
    const result = options(
      {
        availableTools: [],
        tools: [
          {
            name: "runtimeSearch",
            parameters: { type: "object", properties: {} },
            handler: vi.fn<() => Promise<string>>().mockResolvedValue("unused"),
          },
        ],
        mcpServers: {
          github: { type: "http", url: "https://example.test/mcp", tools: ["*"] },
        },
      },
      {
        hostServer,
        toolAliases: { runtimeSearch: "mcp__marshal__runtimeSearch" },
      },
    );

    expect(result.tools).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.mcpServers).toBeUndefined();
    expect(result.toolAliases).toBeUndefined();
  });

  it("uses the same explicit allowlist semantics as Copilot for built-in and host tools", () => {
    const hostServer = testDouble<McpSdkServerConfigWithInstance>({
      type: "sdk",
      name: "Marshal host tools",
      instance: testDouble({}),
    });
    const availableTools = ["Read", "runtimeSearch"];
    const result = options(
      {
        availableTools,
        tools: [
          {
            name: "runtimeSearch",
            parameters: { type: "object", properties: {} },
            handler: vi.fn<() => Promise<string>>().mockResolvedValue("unused"),
          },
        ],
      },
      {
        hostServer,
        toolAliases: { runtimeSearch: "mcp__marshal__runtimeSearch" },
      },
    );

    expect(result.tools).toEqual(["Read"]);
    expect(result.skills).toEqual([]);
    expect(result.mcpServers).toEqual({ marshal: hostServer });
    expect(result.toolAliases).toEqual({ runtimeSearch: "mcp__marshal__runtimeSearch" });
    const effectiveClaudeTools = [
      ...(Array.isArray(result.tools) ? result.tools : []),
      ...Object.keys(result.toolAliases ?? {}),
    ];
    expect(new Set(effectiveClaudeTools)).toEqual(new Set(availableTools));
  });

  it("only exposes repository skills when Skill is explicitly allowed", () => {
    const result = options({ availableTools: ["Skill"] });

    expect(result.tools).toEqual(["Skill"]);
    expect(result.skills).toBe("all");
  });

  it("keeps the existing preset and aliases when availableTools is undefined", () => {
    const result = options({}, { toolAliases: { runtimeSearch: "mcp__marshal__runtimeSearch" } });

    expect(result.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(result.toolAliases).toEqual({ runtimeSearch: "mcp__marshal__runtimeSearch" });
  });

  it("removes disabled built-in tools from the model's context without touching the rest of the preset", () => {
    const result = options({ disabledBuiltInTools: ["AskUserQuestion", "Workflow"] });

    expect(result.disallowedTools).toEqual(["AskUserQuestion", "Workflow"]);
    expect(result.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(options({}).disallowedTools).toBeUndefined();
    expect(options({ disabledBuiltInTools: [] })).not.toHaveProperty("disallowedTools");
  });

  it("uses resume without also assigning a new session ID", () => {
    const result = options(
      {},
      {
        sessionId: "22222222-2222-4222-8222-222222222222",
        resume: true,
      },
    );

    expect(result.resume).toBe("22222222-2222-4222-8222-222222222222");
    expect(result.sessionId).toBeUndefined();
  });

  it("forwards explicit executable and spawn hooks for packaged environments", () => {
    const process = testDouble<SpawnedProcess>({});
    const spawn = vi.fn<(options: SpawnOptions) => SpawnedProcess>(() => process);
    const result = options(
      {},
      {
        client: {
          workspaceDir: String.raw`C:\workspace`,
          env: {},
          pathToClaudeCodeExecutable: String.raw`C:\resources\claude.exe`,
          spawnClaudeCodeProcess: spawn,
        },
      },
    );

    expect(result.pathToClaudeCodeExecutable).toBe(String.raw`C:\resources\claude.exe`);
    expect(result.spawnClaudeCodeProcess).toBe(spawn);
  });

  it("maps stdio, HTTP, SSE, and the in-process host MCP server", () => {
    const hostServer = testDouble<McpSdkServerConfigWithInstance>({
      type: "sdk",
      name: "Marshal host tools",
      instance: testDouble({}),
    });
    const result = toClaudeMcpServers(
      {
        local: {
          type: "local",
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "secret" },
          timeout: 5_000,
          tools: ["*"],
        },
        remote: {
          type: "http",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer token" },
          tools: ["*"],
        },
        legacy: {
          type: "sse",
          url: "https://example.test/sse",
          tools: ["*"],
        },
        disabled: {
          type: "http",
          url: "https://example.test/disabled",
          tools: [],
        },
      },
      hostServer,
    );

    expect(result).toEqual({
      local: {
        type: "stdio",
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "secret" },
        timeout: 5_000,
      },
      remote: {
        type: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer token" },
      },
      legacy: {
        type: "sse",
        url: "https://example.test/sse",
      },
      marshal: hostServer,
    });
  });

  it("does not expose the legacy Playwright MCP alongside Agentic Browser Runtime", () => {
    expect(
      toClaudeMcpServers(
        {
          playwright: { command: "playwright-mcp", tools: ["*"] },
          github: { type: "http", url: "https://example.test/mcp", tools: ["*"] },
        },
        undefined,
      ),
    ).toEqual({
      github: { type: "http", url: "https://example.test/mcp" },
    });
  });

  it("surfaces MCP config features the Claude SDK cannot faithfully represent", () => {
    expect(() =>
      toClaudeMcpServers(
        {
          scoped: {
            command: "node",
            workingDirectory: String.raw`C:\other`,
          },
        },
        undefined,
      ),
    ).toThrow(/per-server working directory/);
    expect(() =>
      toClaudeMcpServers(
        {
          filtered: {
            type: "http",
            url: "https://example.test/mcp",
            tools: ["only_this_tool"],
          },
        },
        undefined,
      ),
    ).toThrow(/tool allowlist/);
    expect(CLAUDE_MCP_OAUTH_UNSUPPORTED_MESSAGE).toContain("Complete OAuth in Marshal");
  });
});
