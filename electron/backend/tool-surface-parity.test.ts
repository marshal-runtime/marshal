import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../testing/harness/test-double";
import { toClaudeQueryOptions } from "./claude/config";
import { ClaudeToolInvocationRegistry } from "./claude/tool-invocations";
import { toCopilotSessionConfig } from "./copilot/sdk-adapter";
import type { RuntimeSessionConfig, RuntimeTool } from "./runtime-contract";

function plannerConfig(): RuntimeSessionConfig {
  return {
    // SessionManager derives this empty allowlist from runtimeAgentRole: "planner".
    availableTools: [],
    tools: [
      {
        name: "runtimeSearch",
        parameters: { type: "object", properties: {} },
        handler: vi.fn<RuntimeTool["handler"]>(async () => "must remain unreachable"),
      },
    ],
  };
}

describe("tool-free planner adapter parity", () => {
  it("gives Copilot and Claude the same empty effective tool surface", () => {
    const config = plannerConfig();
    const hostServer = testDouble<McpSdkServerConfigWithInstance>({
      type: "sdk",
      name: "Marshal host tools",
      instance: testDouble({}),
    });

    const copilot = toCopilotSessionConfig(config);
    const claude = toClaudeQueryOptions({
      client: { workspaceDir: "/workspace", env: {} },
      config,
      sessionId: "11111111-1111-4111-8111-111111111111",
      resume: false,
      hostServer,
      toolAliases: { runtimeSearch: "mcp__marshal__runtimeSearch" },
      invocations: new ClaudeToolInvocationRegistry(),
    });

    expect(copilot.availableTools).toEqual([]);
    expect(claude.tools).toEqual(copilot.availableTools);
    expect(claude.skills).toEqual([]);
    expect(claude.mcpServers).toBeUndefined();
    expect(claude.toolAliases).toBeUndefined();
  });
});
