import {
  tool as sdkTool,
  type CanUseTool,
  type HookCallback,
  type PostToolUseFailureHookInput,
  type PostToolUseHookInput,
  type PreToolUseHookInput,
  type SessionEndHookInput,
  type SubagentStartHookInput,
  type UserPromptSubmitHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../testing/harness/test-double";
import type {
  RuntimePermissionHandler,
  RuntimeSessionHooks,
  RuntimeSubagentStartContext,
  RuntimeTool,
  RuntimeToolCallHint,
} from "../runtime-contract";
import { toClaudeHooks } from "./hooks";
import { createClaudePermissionHandler, toClaudePermissionResult } from "./permissions";
import type { ClaudeSdkFacade } from "./sdk-facade";
import { ClaudeToolInvocationRegistry } from "./tool-invocations";
import { parseClaudeToolName } from "./tool-names";
import { createClaudeRuntimeToolServer } from "./tools";

const signal = new AbortController().signal;

describe("Claude host tool names", () => {
  it("canonicalizes legacy host-tool aliases without changing third-party MCP names", () => {
    expect(parseClaudeToolName("mcp__marshal__marshal_recall").runtimeName).toBe("recall");
    expect(parseClaudeToolName("mcp__github__list_issues").runtimeName).toBe(
      "mcp__github__list_issues",
    );
  });
});

function permissionOptions(toolUseID: string): Parameters<CanUseTool>[2] {
  return testDouble({
    signal,
    toolUseID,
    requestId: `request-${toolUseID}`,
    title: "Claude wants to run a tool",
    displayName: "Run tool",
    description: "Tool description",
    decisionReason: "No allow rule matched",
  });
}

function hookCallback(
  hooks: ReturnType<typeof toClaudeHooks>,
  event: keyof NonNullable<ReturnType<typeof toClaudeHooks>>,
): HookCallback {
  const callback = hooks?.[event]?.[0]?.hooks[0];
  if (!callback) throw new Error(`Missing ${event} hook`);
  return callback;
}

describe("Claude permission mapping", () => {
  it("maps built-in shell requests and actionable Marshal denials", async () => {
    const handler = vi.fn<RuntimePermissionHandler>(() => ({
      kind: "reject",
      feedback: "Blocked by organization policy. Do not retry.",
    }));
    const canUseTool = createClaudePermissionHandler(
      handler,
      "session-1",
      new ClaudeToolInvocationRegistry(),
    );

    await expect(
      canUseTool("Bash", { command: "rm -rf build" }, permissionOptions("tool-1")),
    ).resolves.toEqual({
      behavior: "deny",
      message: "Blocked by organization policy. Do not retry.",
      decisionClassification: "user_reject",
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "shell",
        toolCallId: "tool-1",
        toolName: "Bash",
        command: "rm -rf build",
        serverName: "bash",
        intention: "No allow rule matched",
      }),
      { sessionId: "session-1" },
    );
  });

  it("maps host tools and external MCP tools to their Marshal permission kinds", async () => {
    const handler = vi.fn<RuntimePermissionHandler>(() => ({ kind: "approve-once" }));
    const canUseTool = createClaudePermissionHandler(
      handler,
      "session-1",
      new ClaudeToolInvocationRegistry(),
    );

    await canUseTool("mcp__marshal__remember", { fact: "x" }, permissionOptions("host"));
    await canUseTool("mcp__github__list_issues", { repo: "o/r" }, permissionOptions("mcp"));

    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      kind: "custom-tool",
      toolName: "remember",
      toolCallId: "host",
      arguments: { fact: "x" },
    });
    expect(handler.mock.calls[1]?.[0]).toMatchObject({
      kind: "mcp",
      serverName: "github",
      toolName: "list_issues",
      toolCallId: "mcp",
      toolArgs: { repo: "o/r" },
    });
  });

  it("fails closed for absent or unresolved permission handlers", async () => {
    const canUseTool = createClaudePermissionHandler(
      undefined,
      "session-1",
      new ClaudeToolInvocationRegistry(),
    );

    await expect(
      canUseTool("Read", { file_path: "a.txt" }, permissionOptions("read")),
    ).resolves.toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("no permission handler"),
    });
    expect(toClaudePermissionResult({ kind: "user-not-available" })).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("No approver"),
    });
    expect(toClaudePermissionResult({ kind: "no-result" })).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("not resolved"),
    });
  });
});

describe("Claude hook mapping", () => {
  it("maps tool hooks and preserves pre-tool deny feedback", async () => {
    const onPreToolUse = vi.fn<NonNullable<RuntimeSessionHooks["onPreToolUse"]>>(() => ({
      permissionDecision: "deny",
      permissionDecisionReason: "Wait for capacity instead of retrying.",
    }));
    const onPostToolUse = vi.fn<NonNullable<RuntimeSessionHooks["onPostToolUse"]>>(() => ({
      additionalContext: "Post-tool context",
      updatedToolOutput: "redacted output",
    }));
    const onPostToolUseFailure = vi.fn<NonNullable<RuntimeSessionHooks["onPostToolUseFailure"]>>(
      () => ({ additionalContext: "Failure context" }),
    );
    const hooks = toClaudeHooks(
      { onPreToolUse, onPostToolUse, onPostToolUseFailure },
      "session-1",
      new ClaudeToolInvocationRegistry(),
    );

    await expect(
      hookCallback(hooks, "PreToolUse")(
        testDouble<PreToolUseHookInput>({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__marshal__shell",
          tool_input: { command: "build" },
          tool_use_id: "tool-1",
          cwd: String.raw`C:\workspace`,
          session_id: "session-1",
          transcript_path: "transcript",
        }),
        "tool-1",
        { signal },
      ),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Wait for capacity instead of retrying.",
      },
    });
    await expect(
      hookCallback(hooks, "PostToolUse")(
        testDouble<PostToolUseHookInput>({
          hook_event_name: "PostToolUse",
          tool_name: "mcp__github__list_issues",
          tool_input: { repo: "o/r" },
          tool_response: "raw output",
          tool_use_id: "tool-2",
          cwd: String.raw`C:\workspace`,
          session_id: "session-1",
          transcript_path: "transcript",
        }),
        "tool-2",
        { signal },
      ),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "Post-tool context",
        updatedToolOutput: "redacted output",
      },
    });
    await hookCallback(hooks, "PostToolUseFailure")(
      testDouble<PostToolUseFailureHookInput>({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "build" },
        tool_use_id: "tool-3",
        error: "failed",
        cwd: String.raw`C:\workspace`,
        session_id: "session-1",
        transcript_path: "transcript",
      }),
      "tool-3",
      { signal },
    );

    expect(onPreToolUse).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "shell",
        toolArgs: { command: "build" },
        toolCallId: "tool-1",
        cwd: String.raw`C:\workspace`,
      }),
      { sessionId: "session-1" },
    );
    expect(onPostToolUse).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "mcp__github__list_issues",
        serverName: "github",
        toolResult: "raw output",
      }),
      { sessionId: "session-1" },
    );
    expect(onPostToolUseFailure).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "Bash", error: "failed" }),
      { sessionId: "session-1" },
    );
  });

  it("nudges script-shaped Bash commands toward the scripting tool without blocking", async () => {
    const onPreToolUse = vi.fn<NonNullable<RuntimeSessionHooks["onPreToolUse"]>>(() => ({}));
    const hooks = toClaudeHooks({ onPreToolUse }, "session-1", new ClaudeToolInvocationRegistry(), {
      scriptingToolName: "mcp__marshal__runtimeExecuteTypeScript",
    });
    const preToolUse = (toolName: string, command: string) =>
      hookCallback(hooks, "PreToolUse")(
        testDouble<PreToolUseHookInput>({
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: { command },
          tool_use_id: `tool-${command.length}`,
          cwd: "/workspace",
          session_id: "session-1",
          transcript_path: "transcript",
        }),
        `tool-${command.length}`,
        { signal },
      );

    const nudged = await preToolUse("Bash", "cat data.json | jq '.items[] | .id'");
    expect(nudged).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: expect.stringContaining("mcp__marshal__runtimeExecuteTypeScript"),
      },
    });
    expect(JSON.stringify(nudged)).not.toContain("permissionDecision");
    await expect(preToolUse("Bash", "git status --short")).resolves.toEqual({});
    await expect(preToolUse("mcp__marshal__shell", "jq . file.json")).resolves.toEqual({});
  });

  it("adds the scripting tool's hint to Grep and Bash calls alongside the scripting nudge", async () => {
    const scriptingToolHint = vi.fn<RuntimeToolCallHint>(async ({ toolName }) =>
      toolName === "Grep" || toolName === "Bash" ? `hint for ${toolName}` : undefined,
    );
    const hooks = toClaudeHooks(
      { onPreToolUse: () => ({}) },
      "session-1",
      new ClaudeToolInvocationRegistry(),
      { scriptingToolName: "mcp__marshal__runtimeExecuteTypeScript", scriptingToolHint },
    );
    const preToolUse = (toolName: string, toolInput: Record<string, unknown>) =>
      hookCallback(hooks, "PreToolUse")(
        testDouble<PreToolUseHookInput>({
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: `tool-${toolName}`,
          cwd: "/workspace",
          session_id: "session-1",
          transcript_path: "transcript",
        }),
        `tool-${toolName}`,
        { signal },
      );

    await expect(preToolUse("Grep", { pattern: "retry|backoff" })).resolves.toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "hint for Grep" },
    });
    await expect(
      preToolUse("Bash", { command: "grep -rn 'a|b' src | sort | uniq -c" }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        additionalContext: expect.stringMatching(/is a script[\s\S]*\n\nhint for Bash$/),
      },
    });
    await expect(preToolUse("Read", { file_path: "/a" })).resolves.toEqual({});
    expect(scriptingToolHint).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "Grep",
        sessionId: "session-1",
        scriptingToolName: "mcp__marshal__runtimeExecuteTypeScript",
      }),
    );
  });

  it("denies a call when the scripting tool's hint returns a deny reason, and shows it scripting calls", async () => {
    const scriptingToolName = "mcp__marshal__runtimeExecuteTypeScript";
    const scriptingToolHint = vi.fn<RuntimeToolCallHint>(async ({ toolName }) =>
      toolName === "Grep" ? { denyReason: "search the index first" } : undefined,
    );
    const invocations = new ClaudeToolInvocationRegistry();
    const discard = vi.spyOn(invocations, "discard");
    const hooks = toClaudeHooks({ onPreToolUse: () => ({}) }, "session-1", invocations, {
      scriptingToolName,
      scriptingToolHint,
    });
    const preToolUse = (toolName: string, toolInput: Record<string, unknown>) =>
      hookCallback(hooks, "PreToolUse")(
        testDouble<PreToolUseHookInput>({
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: `tool-${toolName}`,
          cwd: "/workspace",
          session_id: "session-1",
          transcript_path: "transcript",
          agent_id: "agent-1",
        }),
        `tool-${toolName}`,
        { signal },
      );

    await expect(preToolUse("Grep", { pattern: "retry|backoff" })).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "search the index first",
      },
    });
    expect(discard).toHaveBeenCalledWith("Grep", "tool-Grep");
    await expect(preToolUse(scriptingToolName, { source: "return 1" })).resolves.toEqual({});
    expect(scriptingToolHint).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: scriptingToolName, agentId: "agent-1" }),
    );
  });

  it("adds the scripting tool's subagent context when a subagent starts", async () => {
    const scriptingSubagentContext = vi.fn<RuntimeSubagentStartContext>(
      async () => "search the index first",
    );
    const subagentStart = (context?: RuntimeSubagentStartContext) =>
      hookCallback(
        toClaudeHooks(
          { onPreToolUse: () => ({}) },
          "session-1",
          new ClaudeToolInvocationRegistry(),
          {
            scriptingToolName: "mcp__marshal__runtimeExecuteTypeScript",
            scriptingSubagentContext: context,
          },
        ),
        "SubagentStart",
      )(
        testDouble<SubagentStartHookInput>({
          hook_event_name: "SubagentStart",
          agent_id: "agent-1",
          agent_type: "Explore",
          session_id: "session-1",
          transcript_path: "transcript",
          cwd: "/workspace",
        }),
        undefined,
        { signal },
      );

    await expect(subagentStart(scriptingSubagentContext)).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext: "search the index first",
      },
    });
    expect(scriptingSubagentContext).toHaveBeenCalledWith({
      sessionId: "session-1",
      scriptingToolName: "mcp__marshal__runtimeExecuteTypeScript",
    });
    await expect(subagentStart(async () => undefined)).resolves.toEqual({});
  });

  it("maps per-turn prompt context and session-end hooks", async () => {
    const onUserPromptSubmitted = vi.fn<NonNullable<RuntimeSessionHooks["onUserPromptSubmitted"]>>(
      ({ prompt }) => ({ modifiedPrompt: `${prompt}\n\n[fresh context]` }),
    );
    const onSessionEnd = vi.fn<NonNullable<RuntimeSessionHooks["onSessionEnd"]>>();
    const hooks = toClaudeHooks(
      { onUserPromptSubmitted, onSessionEnd },
      "session-1",
      new ClaudeToolInvocationRegistry(),
    );

    await expect(
      hookCallback(hooks, "UserPromptSubmit")(
        testDouble<UserPromptSubmitHookInput>({
          hook_event_name: "UserPromptSubmit",
          prompt: "What day is it?",
          cwd: String.raw`C:\workspace`,
          session_id: "session-1",
          transcript_path: "transcript",
        }),
        undefined,
        { signal },
      ),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "[fresh context]",
      },
    });
    await hookCallback(hooks, "SessionEnd")(
      testDouble<SessionEndHookInput>({
        hook_event_name: "SessionEnd",
        reason: "prompt_input_exit",
        cwd: String.raw`C:\workspace`,
        session_id: "session-1",
        transcript_path: "transcript",
      }),
      undefined,
      { signal },
    );

    expect(onSessionEnd).toHaveBeenCalledWith(
      { reason: "prompt_input_exit" },
      { sessionId: "session-1" },
    );
  });

  it("passes the SDK's UserPromptSubmit source through to onUserPromptSubmitted", async () => {
    const onUserPromptSubmitted = vi.fn<NonNullable<RuntimeSessionHooks["onUserPromptSubmitted"]>>(
      () => undefined,
    );
    const hooks = toClaudeHooks(
      { onUserPromptSubmitted },
      "session-1",
      new ClaudeToolInvocationRegistry(),
    );

    await hookCallback(hooks, "UserPromptSubmit")(
      testDouble<UserPromptSubmitHookInput>({
        hook_event_name: "UserPromptSubmit",
        prompt: "What day is it?",
        source: "loop_wakeup",
        cwd: String.raw`C:\workspace`,
        session_id: "session-1",
        transcript_path: "transcript",
      }),
      undefined,
      { signal },
    );

    expect(onUserPromptSubmitted).toHaveBeenCalledWith(
      {
        prompt: "What day is it?",
        source: "loop_wakeup",
        isBackgroundTaskAutoContinuation: false,
      },
      { sessionId: "session-1" },
    );
  });

  it("flags the CLI's own background-task auto-continuation prompt without blocking it", async () => {
    const onUserPromptSubmitted = vi.fn<NonNullable<RuntimeSessionHooks["onUserPromptSubmitted"]>>(
      () => undefined,
    );
    const hooks = toClaudeHooks(
      { onUserPromptSubmitted },
      "session-1",
      new ClaudeToolInvocationRegistry(),
    );
    // Verbatim shape observed live from the SDK (see manual-bg-wake-repro.
    // test.ts) — the CLI's own generic background-notification frame,
    // distinct from Marshal's own `<marshal-control kind="background-task">`
    // wake. Blocking this turn was tried and made things worse (live
    // testing showed the SDK still runs a full turn/idle cycle for a
    // blocked prompt, just with an "operation blocked by hook" reply
    // instead of a real one) — so it is let through unchanged and only
    // flagged, letting SessionManager skip its own redundant wake instead
    // (electron/sessions.ts, tryWakeSessionForBackgroundTask).
    const taskNotificationPrompt =
      "<task-notification>\n" +
      "<task-id>b6b39dhav</task-id>\n" +
      "<tool-use-id>toolu_01ENxaxoeGGmuBHr5J5N1A13</tool-use-id>\n" +
      "<output-file>/tmp/tasks/b6b39dhav.output</output-file>\n" +
      "<status>failed</status>\n" +
      '<summary>Background command "sleep 8 && exit 1" failed with exit code 1</summary>\n' +
      "</task-notification>";

    await hookCallback(hooks, "UserPromptSubmit")(
      testDouble<UserPromptSubmitHookInput>({
        hook_event_name: "UserPromptSubmit",
        prompt: taskNotificationPrompt,
        source: "system",
        cwd: String.raw`C:\workspace`,
        session_id: "session-1",
        transcript_path: "transcript",
      }),
      undefined,
      { signal },
    );

    expect(onUserPromptSubmitted).toHaveBeenCalledWith(
      {
        prompt: taskNotificationPrompt,
        source: "system",
        isBackgroundTaskAutoContinuation: true,
      },
      { sessionId: "session-1" },
    );
  });

  it("does not flag an ordinary prompt that merely mentions a task notification", async () => {
    const onUserPromptSubmitted = vi.fn<NonNullable<RuntimeSessionHooks["onUserPromptSubmitted"]>>(
      () => undefined,
    );
    const hooks = toClaudeHooks(
      { onUserPromptSubmitted },
      "session-1",
      new ClaudeToolInvocationRegistry(),
    );

    await hookCallback(hooks, "UserPromptSubmit")(
      testDouble<UserPromptSubmitHookInput>({
        hook_event_name: "UserPromptSubmit",
        prompt: "Please summarize how <task-notification> messages are rendered in the UI.",
        source: "user",
        cwd: String.raw`C:\workspace`,
        session_id: "session-1",
        transcript_path: "transcript",
      }),
      undefined,
      { signal },
    );

    expect(onUserPromptSubmitted).toHaveBeenCalledWith(
      {
        prompt: "Please summarize how <task-notification> messages are rendered in the UI.",
        source: "user",
        isBackgroundTaskAutoContinuation: false,
      },
      { sessionId: "session-1" },
    );
  });
});

describe("Claude in-process host tools", () => {
  it("maps RuntimeTool schemas, aliases, invocation IDs, and abort signals", async () => {
    let serverOptions: Parameters<ClaudeSdkFacade["createSdkMcpServer"]>[0] | undefined;
    const createSdkMcpServer = vi.fn<ClaudeSdkFacade["createSdkMcpServer"]>((options) => {
      serverOptions = options;
      return testDouble({ type: "sdk", name: options.name, instance: testDouble({}) });
    });
    const sdk = testDouble<ClaudeSdkFacade>({
      tool: sdkTool,
      createSdkMcpServer,
    });
    const handler = vi.fn<RuntimeTool["handler"]>(async () => "tool output");
    const registry = new ClaudeToolInvocationRegistry();
    const abortController = new AbortController();
    registry.record("host_tool", "tool-call-1", abortController.signal);

    const result = createClaudeRuntimeToolServer(
      sdk,
      [
        {
          name: "host_tool",
          description: "Host tool",
          parameters: {
            type: "object",
            properties: {
              value: { type: "string" },
              optional: { type: "number" },
            },
            required: ["value"],
          },
          supportsAbortSignal: true,
          handler,
        },
        {
          name: "Read",
          overridesBuiltInTool: true,
          handler: async () => "override",
        },
      ],
      "session-1",
      registry,
    );

    expect(result.aliases).toEqual({
      host_tool: "mcp__marshal__host_tool",
      Read: "mcp__marshal__Read",
    });
    const definition = serverOptions?.tools?.[0];
    if (!definition) throw new Error("Host tool definition was not captured");
    await expect(definition.handler({ value: "x" }, {})).resolves.toEqual({
      content: [{ type: "text", text: "tool output" }],
    });
    expect(handler).toHaveBeenCalledWith(
      { value: "x" },
      {
        sessionId: "session-1",
        toolCallId: "tool-call-1",
        toolName: "host_tool",
        arguments: { value: "x" },
        signal: abortController.signal,
      },
    );
  });

  it("marks eager-load host tools as always loaded instead of deferred", () => {
    let serverOptions: Parameters<ClaudeSdkFacade["createSdkMcpServer"]>[0] | undefined;
    const sdk = testDouble<ClaudeSdkFacade>({
      tool: sdkTool,
      createSdkMcpServer: vi.fn<ClaudeSdkFacade["createSdkMcpServer"]>((options) => {
        serverOptions = options;
        return testDouble({ type: "sdk", name: options.name, instance: testDouble({}) });
      }),
    });
    createClaudeRuntimeToolServer(
      sdk,
      [
        { name: "eager_tool", eagerLoad: true, handler: async () => "" },
        { name: "deferred_tool", handler: async () => "" },
      ],
      "session-1",
      new ClaudeToolInvocationRegistry(),
    );

    const [eager, deferred] = serverOptions?.tools ?? [];
    expect(eager?._meta).toEqual({ "anthropic/alwaysLoad": true });
    expect(deferred?._meta).toBeUndefined();
  });

  it("propagates host tool failures to the SDK MCP call", async () => {
    let serverOptions: Parameters<ClaudeSdkFacade["createSdkMcpServer"]>[0] | undefined;
    const sdk = testDouble<ClaudeSdkFacade>({
      tool: sdkTool,
      createSdkMcpServer: vi.fn<ClaudeSdkFacade["createSdkMcpServer"]>((options) => {
        serverOptions = options;
        return testDouble({ type: "sdk", name: options.name, instance: testDouble({}) });
      }),
    });
    createClaudeRuntimeToolServer(
      sdk,
      [
        {
          name: "failing_tool",
          handler: async () => {
            throw new Error("host failure");
          },
        },
      ],
      "session-1",
      new ClaudeToolInvocationRegistry(),
    );

    const definition = serverOptions?.tools?.[0];
    if (!definition) throw new Error("Host tool definition was not captured");
    await expect(definition.handler({}, {})).rejects.toThrow("host failure");
  });
});
