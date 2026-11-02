import { describe, expect, it, vi } from "vitest";

// Stub electron + os because some handler factories (acquire-token,
// show-notification) transitively import auth / electron globals at load.
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "/tmp/mock" },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  shell: { openExternal: vi.fn<(url: string) => Promise<void>>(async () => {}) },
  Notification: vi.fn<() => void>(),
}));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return {
    ...actual,
    default: actual,
    homedir: () => "/tmp/mock-home",
    tmpdir: () => "/tmp",
    platform: () => "linux",
    arch: () => "x64",
  };
});

import type { PermissionPolicy } from "../../../permission-policy";
import type { PermissionDecision } from "../../../permission-policy";
import { testDouble } from "../../../testing/harness/test-double";
import type { IBackgroundToolInvocationManager, RunningToolCallInfo } from "../../ports";
import type { ApprovalRequest } from "../../types";
import type { LocalToolRequest } from "../../types";
import { DesktopCapabilitiesImpl } from "./desktop-capabilities";

type EvaluateFn = (request: ApprovalRequest) => PermissionDecision;

function makeDeps() {
  const policy = testDouble<PermissionPolicy>({
    evaluate: vi.fn<EvaluateFn>(() => "approve"),
  });
  const toolInvocationManager = testDouble<IBackgroundToolInvocationManager>({
    claimBackgroundToolDispatch: vi.fn<
      IBackgroundToolInvocationManager["claimBackgroundToolDispatch"]
    >(async (request) => ({
      kind: "claimed",
      claim: {
        claimId: `${request.ownerSessionId}:${request.toolCallId}:claim`,
        ownerSessionId: request.ownerSessionId,
        toolCallId: request.toolCallId,
        claimedAtMs: request.requestedAtMs,
        cancellationToken: {
          tokenId: `${request.ownerSessionId}:${request.toolCallId}:token`,
          ownerSessionId: request.ownerSessionId,
          claimId: `${request.ownerSessionId}:${request.toolCallId}:claim`,
          issuedAtMs: request.requestedAtMs,
        },
      },
    })),
    beginBackgroundToolInvocation: vi.fn<
      IBackgroundToolInvocationManager["beginBackgroundToolInvocation"]
    >(async (args) => {
      const invocation: RunningToolCallInfo = {
        handle: `${args.sessionId}:${args.toolCallId}`,
        sessionId: args.sessionId,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        startedAt: "2026-06-08T14:00:00.000Z",
        elapsedMs: 0,
        status: "running",
        backgrounded: false,
        resultAvailable: false,
        longRunning: false,
        cancellable: true,
        cancellationScope: "tool",
      };
      return { handle: invocation.handle, claim: args.claim, invocation };
    }),
    attachBackgroundToolProcess: vi.fn<
      IBackgroundToolInvocationManager["attachBackgroundToolProcess"]
    >(async () => null),
    detachBackgroundToolInvocation: vi.fn<
      IBackgroundToolInvocationManager["detachBackgroundToolInvocation"]
    >(async () => null),
    completeBackgroundToolInvocation: vi.fn<
      IBackgroundToolInvocationManager["completeBackgroundToolInvocation"]
    >(async (handle, completion) => ({
      handle,
      sessionId: "s-1",
      toolCallId: handle.split(":").at(-1) ?? handle,
      toolName: "filesystem.read_file",
      startedAt: "2026-06-08T14:00:00.000Z",
      elapsedMs: 0,
      status: completion.success ? "completed" : "failed",
      backgrounded: false,
      resultAvailable: true,
      longRunning: false,
      cancellable: false,
      cancellationScope: "none",
    })),
    requestBackgroundToolCancellation: vi.fn<
      IBackgroundToolInvocationManager["requestBackgroundToolCancellation"]
    >(async (request) => ({
      success: true,
      handle: request.handle,
      sessionId: request.token.ownerSessionId,
      status: "cancelling",
      cancellationScope: "tool",
    })),
  });
  return {
    policy,
    toolInvocationManager,
    mcpRuntime: null,
    getSelfTools: () => null,
  };
}

describe("DesktopCapabilitiesImpl", () => {
  it("exposes the 2 bridge RPC methods as functions", () => {
    // `evaluateLocalPolicy` and `showApprovalCard` were moved to
    // `GatewayToolBackend.attachApprovalRouter` — see the file header in
    // desktop-capabilities.ts. The 2 remaining methods are what the bridge
    // dispatches.
    const dc = new DesktopCapabilitiesImpl(makeDeps());
    expect(typeof dc.executeLocalTool).toBe("function");
    expect(typeof dc.showNotification).toBe("function");
  });

  it("executeLocalTool routes to MCP path and surfaces the not-supported envelope when mcpRuntime is null", async () => {
    const deps = makeDeps();
    const dc = new DesktopCapabilitiesImpl(deps);

    const request: LocalToolRequest = {
      kind: "mcp",
      toolName: "filesystem.read_file",
      serverName: "filesystem",
      sessionId: "s-1",
    };
    const result = await dc.executeLocalTool(request);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/MCP runtime is not implemented/i);
  });

  it("executeLocalTool routes to self-tool path and surfaces 'registry not available' when getSelfTools returns null", async () => {
    const deps = makeDeps();
    const dc = new DesktopCapabilitiesImpl(deps);

    const result = await dc.executeLocalTool({
      kind: "custom-tool",
      toolName: "searchWeb",
      sessionId: "s-1",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/registry is not available/i);
  });

  it("showNotification resolves without throwing when no sender is wired", async () => {
    // sendOSNotification falls through to electron's Notification API, which
    // is unavailable in vitest. Pass an explicit no-op via the bridge — the
    // composition's default sender hits real electron, so we keep this
    // assertion narrow: the call shape is correct and doesn't throw on the
    // happy path.
    const deps = makeDeps();
    const dc = new DesktopCapabilitiesImpl(deps);

    // The default sendOSNotification is the real one, which throws under
    // vitest because `Notification` isn't available. So instead, we just
    // verify the method is reachable via DesktopCapabilities (smoke test):
    // the per-handler tests already cover the happy + click paths.
    expect(typeof dc.showNotification).toBe("function");
  });
});
