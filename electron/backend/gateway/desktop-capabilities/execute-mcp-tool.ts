/**
 * `executeLocalTool` — MCP-tool path. `mcpRuntime: null` is the default
 * until lobster's `desktopCapabilities.localTools` flag flips; the handler
 * surfaces a `not-supported` envelope until then.
 *
 * Spec: docs/specs/gateway-automations-phase-2b-design.md §5.1 (RPC #1).
 */

import {
  DesktopCapabilityErrorThrow,
  type LocalToolRequest,
  type LocalToolResult,
} from "../../types";

/**
 * The future MCP runtime contract. Defined here as the integration point so
 * the bridge in dispatch 4 (and any future PR) knows what shape to plug in.
 * Stays an interface — actual implementation lives in a sibling file when it
 * arrives, so this handler doesn't grow a `mcp-runtime.ts` for v0.
 *
 * Expected landing location: `electron/backend/gateway/desktop-capabilities/mcp-runtime.ts`
 * (sibling file in this folder, not `electron/mcp-tools.ts` — the existing
 * client there is per-session, while this runtime is per-cloud-call).
 */
export interface McpRuntime {
  /**
   * Invoke a tool on a named MCP server. The runtime is responsible for
   * server-spawn, JSON-RPC framing, and error mapping. Resolves with the
   * tool's structured result; throws on unknown server, transport error,
   * or remote tool error.
   */
  callTool(opts: {
    serverName: string;
    toolName: string;
    args: unknown;
    signal?: AbortSignal;
  }): Promise<unknown>;
  /** True when the named server is connected and accepting requests. */
  hasServer(serverName: string): boolean;
  /** True only when callTool honors the AbortSignal option. */
  supportsAbortSignal?: boolean;
}

export interface ExecuteMcpToolDeps {
  /**
   * MCP runtime. `null` (the default) means "MCP runtime not implemented" —
   * the handler surfaces a clean error envelope. When non-null, the handler
   * routes each request through the runtime.
   */
  mcpRuntime: McpRuntime | null;
}

export function makeExecuteMcpToolHandler(deps: ExecuteMcpToolDeps) {
  return async function executeMcpTool(
    request: LocalToolRequest,
    signal?: AbortSignal,
  ): Promise<LocalToolResult> {
    const { mcpRuntime } = deps;

    if (!request.serverName) {
      return {
        output: null,
        success: false,
        error: "Missing 'serverName' for MCP tool call",
      };
    }

    if (!mcpRuntime) {
      // Deferred path. Surfaces as `tool-error` to the cloud — the
      // capability flag (`desktopCapabilities.localTools`) is `false` so a
      // well-behaved cloud caller never lands here in production. This guard
      // exists so a misbehaving / pre-flag-flip caller gets a structured
      // error rather than a silent hang.
      return {
        output: null,
        success: false,
        error:
          "MCP runtime is not implemented in this build. The desktop-side MCP client " +
          "lands together with the cloud-side runtime that invokes it (lobster #localTools).",
      };
    }

    if (!mcpRuntime.hasServer(request.serverName)) {
      // The cloud routed an MCP call to a server we don't host. This is a
      // wire-level category error (not a tool-level result), so throw
      // structured — the bridge unwraps `code` to `not-supported` on the
      // response envelope.
      throw new DesktopCapabilityErrorThrow(
        "not-supported",
        `MCP server not registered: ${request.serverName}`,
      );
    }

    try {
      const output = await mcpRuntime.callTool({
        serverName: request.serverName,
        toolName: request.toolName,
        args: request.toolArgs,
        ...(signal ? { signal } : {}),
      });
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
