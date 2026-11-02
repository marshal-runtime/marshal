/**
 * `executeLocalTool` — self-tool path.
 *
 * Routes a cloud-supplied tool call into m's existing self-tool registry
 * (`getSelfTools()` in electron/self-tools.ts). The registry is a flat array
 * of `{ name, parameters, handler }` objects; we look up by `toolName`,
 * invoke the handler with `toolArgs`, and wrap the result.
 *
 * Self-tool handlers return JSON strings by convention. We surface the raw
 * string as `output` — the cloud caller is responsible for parsing.
 *
 * Defense-in-depth: we re-run `PermissionPolicy.evaluate` on the incoming
 * request and refuse on `"deny"` — same shape execute-shell uses. Self-tools
 * include `logWork`, `createSession`, etc. which have non-trivial side
 * effects; the cloud is the authoritative gate, but a categorical `"deny"`
 * must hold here too against a buggy or compromised cloud caller.
 *
 * Spec: docs/specs/gateway-automations-phase-2b-design.md §5.1 (RPC #1).
 */

import { randomUUID } from "node:crypto";

import { canonicalizeFirstPartyToolName } from "../../../../common/tool-names";
import type { IPermissionPolicy } from "../../ports";
import type {
  RuntimeTool,
  RuntimeToolHandler,
  RuntimeToolInvocation,
} from "../../runtime-contract";
import type { ApprovalRequest } from "../../types";
import {
  DesktopCapabilityErrorThrow,
  type LocalToolRequest,
  type LocalToolResult,
} from "../../types";

/** Subset of the runtime-neutral tool shape this handler actually reads. */
export interface SelfToolEntry {
  name: string;
  handler: RuntimeToolHandler;
}

export interface ExecuteSelfToolDeps {
  /**
   * Permission policy port — defense-in-depth re-check before invoking the
   * self-tool. Mirrors `execute-shell`: cloud is the authoritative gate
   * (and may carry user-approved decisions), but the categorical `"deny"`
   * floor must hold locally too. Only `policy.evaluate` is consulted, so the
   * narrow `IPermissionPolicy` port is sufficient.
   */
  policy: IPermissionPolicy;
  /**
   * Self-tool registry, lazily resolved per request. Accepts the session ID
   * so Gateway can build self-tools with the correct `currentSessionId` for
   * each incoming RPC call, rather than the static value set at registration
   * time. Returning `null` means "self-tools not yet ready".
   */
  getSelfTools: (sessionId: string) => readonly RuntimeTool[] | null;
}

export function makeExecuteSelfToolHandler(deps: ExecuteSelfToolDeps) {
  return async function executeSelfTool(
    request: LocalToolRequest,
    signal?: AbortSignal,
  ): Promise<LocalToolResult> {
    const tools = deps.getSelfTools(request.sessionId);
    if (!tools) {
      return {
        output: null,
        success: false,
        error: "Self-tool registry is not available yet",
      };
    }

    const toolName = canonicalizeFirstPartyToolName(request.toolName);
    const entry = findEntry(tools, toolName);
    if (!entry) {
      return {
        output: null,
        success: false,
        error: `Unknown self-tool: ${toolName}`,
      };
    }

    // Defense-in-depth: re-evaluate policy. Cloud is the authoritative gate
    // (and may carry user-approved decisions we'd block in isolation), but a
    // categorical "deny" must hold here too. "approve" and "prompt" both
    // proceed — the cloud has already shown approval UI for "prompt".
    const permissionRequest: ApprovalRequest = {
      id: randomUUID(),
      sessionId: request.sessionId,
      toolCallId: undefined,
      kind: "custom-tool",
      toolName,
      toolDescription: undefined,
      // SF-4: toolArgs from trusted internal RPC, not user input — narrowing to Record<string, unknown> is safe
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- object check guards the cast
      toolArgs: (request.toolArgs &&
      typeof request.toolArgs === "object" &&
      !Array.isArray(request.toolArgs)
        ? request.toolArgs
        : {}) as Record<string, unknown>,
      intention: undefined,
      warning: undefined,
      commandIdentifiers: [],
    };
    if (deps.policy.evaluate(permissionRequest) === "deny") {
      throw new DesktopCapabilityErrorThrow(
        "policy-deny",
        `Self-tool blocked by local policy: ${toolName}`,
      );
    }

    try {
      const invocation: RuntimeToolInvocation = {
        sessionId: request.sessionId,
        toolCallId: request.toolCallId ?? randomUUID(),
        toolName,
        arguments: request.toolArgs,
        ...(signal ? { signal } : {}),
      };
      const output = await entry.handler(request.toolArgs, invocation);
      return { output, success: true };
    } catch (err) {
      return {
        output: null,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

function findEntry(tools: readonly RuntimeTool[], name: string): SelfToolEntry | null {
  for (const t of tools) {
    if (t.name === name && t.handler) {
      return { name: t.name, handler: t.handler };
    }
  }
  return null;
}
