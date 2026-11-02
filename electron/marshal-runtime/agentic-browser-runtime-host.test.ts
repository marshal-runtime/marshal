import type { InvocationContext } from "@marshal/runtime";
import { describe, expect, it, vi } from "vitest";

import { createMarshalAgenticBrowserRuntimeHostModule } from "./agentic-browser-runtime-host";
import type { MarshalRuntimeBrowserCommandExecutorPort } from "./browser-command-executor";
import type { MarshalRuntimeAuthorityPort } from "./contracts";
import { MarshalRuntimeUiController, type RuntimeUiDeliveryPorts } from "./ui-controller";

function invocation(
  sessionId: string,
  workspaceName: string,
  executionId?: string,
): InvocationContext {
  return {
    principal: { id: "browser-test", kind: "agent" },
    scope: { sessionId },
    ...(executionId ? { executionId } : {}),
    metadata: { marshalWorkspaceName: workspaceName },
  };
}

describe("Marshal agentic browser runtime host module", () => {
  it("reuses a browser session across executions and isolates chats and workspaces", async () => {
    const authority: MarshalRuntimeAuthorityPort = {
      resolveScope: vi.fn<MarshalRuntimeAuthorityPort["resolveScope"]>(async (scope) => ({
        ...scope,
        workspacePath: `Q:\\workspaces\\${scope.workspaceName}`,
      })),
      authorize: vi.fn<MarshalRuntimeAuthorityPort["authorize"]>(async () => ({
        decision: "allow",
      })),
    };
    const execute = vi.fn<MarshalRuntimeBrowserCommandExecutorPort["execute"]>(async () => {
      throw new Error("connector unavailable");
    });
    const module = createMarshalAgenticBrowserRuntimeHostModule({
      authority,
      executor: { execute, dispose: async () => undefined },
      ui: createUiController(),
    });

    const first = module.resolveBrowserSession(invocation("session-1", "workspace-a", "exec-1"));
    const replay = module.resolveBrowserSession(invocation("session-1", "workspace-a", "exec-1"));
    const otherExecution = module.resolveBrowserSession(
      invocation("session-1", "workspace-a", "exec-2"),
    );
    const otherWorkspace = module.resolveBrowserSession(
      invocation("session-1", "workspace-b", "exec-1"),
    );
    const otherSession = module.resolveBrowserSession(
      invocation("session-2", "workspace-a", "exec-1"),
    );

    expect(replay).toEqual({ context: first.context, created: false });
    expect(otherExecution).toEqual({ context: first.context, created: false });
    expect(
      new Set([
        first.context.browserSessionId,
        otherWorkspace.context.browserSessionId,
        otherSession.context.browserSessionId,
      ]).size,
    ).toBe(3);
    expect(() => module.resolveBrowserSession(invocation("session-1", "workspace-a"))).toThrow(
      "require an execution identity",
    );

    await expect(
      module.invokeBrowserCommand(
        "browser_navigate",
        { url: "https://example.com" },
        first.context,
      ),
    ).rejects.toThrow("connector unavailable");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        context: first.context,
        scope: {
          sessionId: "session-1",
          workspaceName: "workspace-a",
          workspacePath: "Q:\\workspaces\\workspace-a",
        },
      }),
    );
    await module.dispose();
  });

  it("opens, updates, focuses, and closes its Runtime UI panel", async () => {
    const ui = createUiController();
    const events: string[] = [];
    ui.subscribe((event) => events.push(event.type));
    const disposeExecutor = vi.fn<MarshalRuntimeBrowserCommandExecutorPort["dispose"]>(
      async () => undefined,
    );
    const module = createMarshalAgenticBrowserRuntimeHostModule({
      authority: {
        resolveScope: async (scope) => ({ ...scope, workspacePath: "Q:\\workspace" }),
        authorize: async () => ({ decision: "allow" }),
      },
      executor: {
        execute: async () => {
          throw new Error("Unexpected browser execution.");
        },
        dispose: disposeExecutor,
      },
      ui,
    });
    const { context } = module.resolveBrowserSession(
      invocation("session-1", "workspace-a", "exec-1"),
    );

    await module.openOrFocusPanel(context);
    await module.publishLifecycleEvent({
      id: "event-navigation",
      type: "navigation",
      occurredAt: "2026-08-17T08:00:00.000Z",
      context,
      command: "browser_navigate",
      details: { input: { url: "https://example.com" } },
    });
    await module.openOrFocusPanel(context);
    await module.publishLifecycleEvent({
      id: "event-completion",
      type: "completion",
      occurredAt: "2026-08-17T08:00:01.000Z",
      context,
      command: "browser_navigate",
      details: {
        result: {
          success: true,
          data: {
            content: [
              {
                type: "text",
                text: [
                  "### Page state",
                  "- Page URL: https://example.com/",
                  "- Page Title: Example Domain",
                  "- Page Snapshot:",
                  "```yaml",
                  '- heading "Example Domain" [level=1]',
                  "```",
                ].join("\n"),
              },
              { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
            ],
          },
        },
      },
    });
    const snapshot = await ui.snapshot({ sessionId: "session-1", workspaceName: "workspace-a" });
    const otherScope = await ui.snapshot({
      sessionId: "session-1",
      workspaceName: "workspace-b",
    });
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        instances: [
          {
            owner: {
              sessionId: "session-1",
              workspaceName: "workspace-a",
              extensionId: "@agentic-browser/marshal-runtime-extension",
              applicationId: "browser-session",
            },
            surface: "panel",
            content: {
              kind: "application",
              renderId: "marshal.agentic-browser.v1",
              state: {
                status: "completed",
                command: "browser_navigate",
                url: "https://example.com/",
                title: "Example Domain",
                accessibility: '- heading "Example Domain" [level=1]',
                screenshot: { mimeType: "image/png", data: "aW1hZ2U=" },
              },
            },
          },
        ],
      },
    });
    expect(otherScope).toMatchObject({ ok: true, value: { instances: [] } });
    await expect(module.openOrFocusPanel({ ...context, chatId: "session-2" })).rejects.toThrow(
      "session context is invalid",
    );
    await module.dispose();

    expect(events).toEqual([
      "instance-opened",
      "instance-updated",
      "instance-focused",
      "instance-updated",
      "instance-closed",
    ]);
    expect(disposeExecutor).toHaveBeenCalledOnce();
  });
});

function createUiController(): MarshalRuntimeUiController {
  const delivery: RuntimeUiDeliveryPorts = {
    notification: vi.fn<RuntimeUiDeliveryPorts["notification"]>(),
    chatMessage: vi.fn<RuntimeUiDeliveryPorts["chatMessage"]>(),
    chatCard: vi.fn<RuntimeUiDeliveryPorts["chatCard"]>(),
  };
  return new MarshalRuntimeUiController(
    () => Date.parse("2026-08-17T08:00:00.000Z"),
    (request) => ({ allowed: true, scope: request.scope }),
    delivery,
  );
}
