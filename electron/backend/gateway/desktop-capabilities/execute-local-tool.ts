/**
 * DesktopCapabilities RPC #1 — `executeLocalTool`.
 *
 * Routes a cloud-supplied tool call to one of three per-kind handlers:
 *   - `kind: "mcp"`         → execute-mcp-tool (deferred — see file)
 *   - `kind: "shell"`       → execute-shell
 *   - `kind: "custom-tool"` → execute-self-tool
 *
 * Each per-kind handler is a focused module with its own tests (this file
 * only tests the routing). Dependency injection is per-handler — the bridge
 * (dispatch 4) wires the three sub-handlers and passes them in here.
 *
 * Spec: docs/specs/gateway-automations-phase-2b-design.md §5.1 (RPC #1).
 */

import { randomUUID } from "node:crypto";

import { canonicalizeFirstPartyToolName } from "../../../../common/tool-names";
import {
  backgroundToolObservation,
  type InternalToolExecution,
  NEVER_BACKGROUND_TOOL_NAMES,
  runRetainableToolWithBackgrounding,
} from "../../../tool-backgrounding";
import {
  type BackgroundToolProcessAttacher,
  type IBackgroundToolInvocationManager,
} from "../../ports";
import {
  DesktopCapabilityErrorThrow,
  type LocalToolRequest,
  type LocalToolResult,
} from "../../types";

const BACKGROUND_TOOL_EXCLUDED_NAMES = new Set([
  "askUser",
  "report_intent",
  "listRunningTools",
  "inspectRunningTool",
  "cancelRunningTool",
  ...NEVER_BACKGROUND_TOOL_NAMES,
]);

export interface ExecuteLocalToolDeps {
  executeMcpTool: (request: LocalToolRequest, signal?: AbortSignal) => Promise<LocalToolResult>;
  executeShell: (
    request: LocalToolRequest,
    signal?: AbortSignal,
    attachProcess?: BackgroundToolProcessAttacher,
  ) => Promise<InternalToolExecution<LocalToolResult>>;
  executeSelfTool: (request: LocalToolRequest, signal?: AbortSignal) => Promise<LocalToolResult>;
  supportsAbortSignal: (request: LocalToolRequest) => boolean;
  toolInvocationManager: IBackgroundToolInvocationManager;
}

export function makeExecuteLocalToolHandler(deps: ExecuteLocalToolDeps) {
  return async function executeLocalTool(request: LocalToolRequest): Promise<LocalToolResult> {
    const operationToolCallId = request.toolCallId ?? randomUUID();
    const normalizedRequest: LocalToolRequest & { toolCallId: string } = {
      ...request,
      toolName:
        request.kind === "custom-tool"
          ? canonicalizeFirstPartyToolName(request.toolName)
          : request.toolName,
      toolCallId: operationToolCallId,
    };
    if (
      normalizedRequest.kind !== "shell" &&
      BACKGROUND_TOOL_EXCLUDED_NAMES.has(normalizedRequest.toolName)
    ) {
      const execution = await executeLocalToolNow(
        deps,
        normalizedRequest,
        new AbortController().signal,
      );
      return execution.result;
    }
    return await runRetainableToolWithBackgrounding({
      manager: deps.toolInvocationManager,
      sessionId: normalizedRequest.sessionId,
      toolCallId: normalizedRequest.toolCallId,
      toolName: normalizedRequest.toolName,
      ...(normalizedRequest.serverName ? { serverName: normalizedRequest.serverName } : {}),
      enableAbortSignal: deps.supportsAbortSignal(normalizedRequest),
      ...(normalizedRequest.kind === "shell" ? { cancellationScope: "none" as const } : {}),
      run: (signal, attachProcess) =>
        executeLocalToolNow(deps, normalizedRequest, signal, attachProcess),
      retainedResult: (result, { handle }) => ({ ...result, backgrounded: true, handle }),
      completionForResult: (result) => ({
        success: result.success,
        result,
        ...(result.error ? { error: result.error } : {}),
      }),
      detachedResult: ({ handle }) => ({
        output: backgroundToolObservation(normalizedRequest.toolName, handle),
        success: true,
        backgrounded: true,
        handle,
      }),
    });
  };
}

async function executeLocalToolNow(
  deps: ExecuteLocalToolDeps,
  request: LocalToolRequest,
  signal: AbortSignal,
  attachProcess?: BackgroundToolProcessAttacher,
): Promise<InternalToolExecution<LocalToolResult>> {
  switch (request.kind) {
    case "mcp":
      return { kind: "completed", result: await deps.executeMcpTool(request, signal) };
    case "shell":
      return await deps.executeShell(request, signal, attachProcess);
    case "custom-tool":
      return { kind: "completed", result: await deps.executeSelfTool(request, signal) };
    // The remaining PermissionKind values ("read", "write", "url") classify
    // tool calls into permission categories but don't correspond to a
    // distinct executor — they're sub-cases of the three above (a "read"
    // is an MCP filesystem.read_file, a "url" is playwright.browser_navigate,
    // etc.). The cloud must classify them as one of mcp/shell/custom-tool
    // before invoking executeLocalTool. Throw a structured envelope that
    // matches `execute-mcp-tool`'s unknown-server shape so the cloud's error
    // handling sees a uniform `not-supported` code across all dispatchers.
    default:
      throw new DesktopCapabilityErrorThrow(
        "not-supported",
        `Unsupported tool kind for executeLocalTool: ${request.kind}`,
      );
  }
}
