import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import type {
  RuntimePermissionHandler,
  RuntimePermissionRequest,
  RuntimePermissionResult,
} from "../runtime-contract";
import type { ClaudeToolInvocationRegistry } from "./tool-invocations";
import { parseClaudeToolName } from "./tool-names";

function stringField(input: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string") return value;
  }
  return "";
}

function toRuntimePermissionRequest(
  toolName: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
): RuntimePermissionRequest {
  const parsed = parseClaudeToolName(toolName);
  const common = {
    toolCallId: options.toolUseID,
    toolName: parsed.runtimeName,
    arguments: input,
    title: options.title,
    toolTitle: options.displayName,
    toolDescription: options.description,
    intention: options.decisionReason,
    blockedPath: options.blockedPath,
    requestId: options.requestId,
    suggestions: options.suggestions,
    matchedAskRule: options.matchedAskRule,
    agentId: options.agentID,
  };

  if (parsed.serverName) {
    return parsed.isHostTool
      ? { kind: "custom-tool", ...common }
      : {
          kind: "mcp",
          ...common,
          serverName: parsed.serverName,
          toolName: parsed.mcpToolName ?? parsed.runtimeName,
          toolArgs: input,
        };
  }

  switch (toolName) {
    case "Bash":
      return {
        kind: "shell",
        ...common,
        command: stringField(input, "command", "cmd"),
        serverName: "bash",
      };
    case "Read":
      return { kind: "read", ...common, path: stringField(input, "file_path", "path") };
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return {
        kind: "write",
        ...common,
        path: stringField(input, "file_path", "notebook_path", "path"),
        diff: null,
      };
    case "WebFetch":
      return { kind: "url", ...common, url: stringField(input, "url") };
    case "WebSearch":
      return { kind: "url", ...common, url: stringField(input, "query") };
    default:
      return { kind: "custom-tool", ...common };
  }
}

function toClaudePermissionResult(result: RuntimePermissionResult): PermissionResult {
  switch (result.kind) {
    case "approve-once":
      return {
        behavior: "allow",
        decisionClassification: "user_temporary",
      };
    case "reject":
      return {
        behavior: "deny",
        message: result.feedback ?? "The user denied this tool request.",
        decisionClassification: "user_reject",
      };
    case "user-not-available":
      return {
        behavior: "deny",
        message: "No approver is available for this tool request. Do not retry it unchanged.",
      };
    case "no-result":
      return {
        behavior: "deny",
        message: "The permission request was not resolved. Do not execute the tool.",
      };
  }
  throw new Error("Unsupported runtime permission result");
}

export function createClaudePermissionHandler(
  handler: RuntimePermissionHandler | undefined,
  sessionId: string,
  invocations: ClaudeToolInvocationRegistry,
  allowedToolNames?: ReadonlySet<string>,
): CanUseTool {
  return async (toolName, input, options) => {
    const parsed = parseClaudeToolName(toolName);
    if (
      allowedToolNames &&
      !allowedToolNames.has(toolName) &&
      !allowedToolNames.has(parsed.runtimeName)
    ) {
      return {
        behavior: "deny",
        message: "This tool is not available in this session.",
      };
    }
    invocations.record(parsed.runtimeName, options.toolUseID, options.signal);
    if (!handler) {
      invocations.discard(parsed.runtimeName, options.toolUseID);
      return {
        behavior: "deny",
        message: "Marshal has no permission handler configured for this session.",
      };
    }

    const result = await handler(toRuntimePermissionRequest(toolName, input, options), {
      sessionId,
    });
    const mapped = toClaudePermissionResult(result);
    if (mapped.behavior === "deny") {
      invocations.discard(parsed.runtimeName, options.toolUseID);
    }
    return mapped;
  };
}

export { toClaudePermissionResult, toRuntimePermissionRequest };
