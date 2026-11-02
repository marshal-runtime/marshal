/**
 * DesktopCapabilitiesImpl — composition of the 2 RPC handler factories that
 * flow through the `desktop.*` bridge. Approval routing moved to
 * `IToolBackend.attachApprovalRouter` — see file header in `backend.ts`.
 *
 * Spec: docs/specs/gateway-automations-phase-2b-design.md §5.1.
 */

import type { IPermissionPolicy } from "../../ports";
import type { RuntimeTool } from "../../runtime-contract";
import type {
  DesktopCapabilities,
  IBackgroundToolInvocationManager,
  LocalToolRequest,
  LocalToolResult,
  NotificationRequest,
} from "../../types";
import { makeExecuteLocalToolHandler } from "./execute-local-tool";
import { type McpRuntime, makeExecuteMcpToolHandler } from "./execute-mcp-tool";
import { makeExecuteSelfToolHandler } from "./execute-self-tool";
import { makeExecuteShellHandler } from "./execute-shell";
import { makeShowNotificationHandler } from "./show-notification";

export interface DesktopCapabilitiesDeps {
  /**
   * Permission policy port. Drives the `executeShell` and `executeSelfTool`
   * defense-in-depth re-checks before invoking the underlying handler.
   * (The `evaluateLocalPolicy` and `showApprovalCard` paths that also used
   * policy moved to `GatewayToolBackend.attachApprovalRouter` — see file
   * header.)
   */
  policy: IPermissionPolicy;
  toolInvocationManager: IBackgroundToolInvocationManager;
  /**
   * MCP runtime adapter for `executeLocalTool({ kind: "mcp" })`. Pass `null`
   * (the v0 default until lobster ships its localTools consumer) to surface a
   * clean "not implemented" error envelope. Spec §5.6.
   */
  mcpRuntime?: McpRuntime | null;
  /**
   * Self-tool registry accessor for `executeLocalTool({ kind: "custom-tool" })`.
   * Lazily-resolved so the bridge can wire in `SelfToolDeps` after construction
   * (SessionManager pushes self-tools into the backend post-init).
   */
  getSelfTools: (sessionId: string) => readonly RuntimeTool[] | null;
  /**
   * Notification click router for notifications whose
   * `onClickAction.type === "openSession"`. Optional — when absent, the click
   * is silently ignored (the native notification still dismisses).
   */
  onSessionOpenRequested?: (sessionId: string) => void;
}

export class DesktopCapabilitiesImpl implements DesktopCapabilities {
  readonly executeLocalTool: (request: LocalToolRequest) => Promise<LocalToolResult>;
  readonly showNotification: (notification: NotificationRequest) => Promise<void>;

  constructor(deps: DesktopCapabilitiesDeps) {
    this.showNotification = makeShowNotificationHandler({
      onSessionOpenRequested: deps.onSessionOpenRequested,
    });
    const mcpRuntime = deps.mcpRuntime ?? null;
    this.executeLocalTool = makeExecuteLocalToolHandler({
      executeMcpTool: makeExecuteMcpToolHandler({ mcpRuntime }),
      executeShell: makeExecuteShellHandler({ policy: deps.policy }),
      executeSelfTool: makeExecuteSelfToolHandler({
        policy: deps.policy,
        getSelfTools: deps.getSelfTools,
      }),
      supportsAbortSignal: (request) =>
        request.kind === "shell" ||
        (request.kind === "mcp" && mcpRuntime?.supportsAbortSignal === true),
      toolInvocationManager: deps.toolInvocationManager,
    });
  }
}
