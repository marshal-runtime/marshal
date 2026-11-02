import { describe, expect, it, vi } from "vitest";

import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import {
  RUNTIME_UI_USER_SCOPE,
  type RuntimeUiApplicationHostCommand,
} from "../../common/runtime-ui";
import {
  MarshalRuntimeUiController,
  type RuntimeUiDeliveryPorts,
} from "../marshal-runtime/ui-controller";
import { testDouble } from "../testing/harness";
import {
  registerRuntimeUiSessionSelectionHandlers,
  type RuntimeUiSessionSelectionPorts,
} from "./runtime-ui-session-selection";

async function harness() {
  const controller = new MarshalRuntimeUiController(
    Date.now,
    (request) => ({ allowed: true, scope: request.scope }),
    {
      notification: vi.fn<RuntimeUiDeliveryPorts["notification"]>(),
      chatMessage: vi.fn<RuntimeUiDeliveryPorts["chatMessage"]>(),
      chatCard: vi.fn<RuntimeUiDeliveryPorts["chatCard"]>(),
    },
  );
  const result = await controller.open({
    ...RUNTIME_UI_USER_SCOPE,
    extensionId: "fixture",
    applicationId: "review",
    surface: "tab",
    idempotencyKey: "open",
    content: {
      kind: "application",
      renderId: "fixture.review",
      resource: { uri: "ui://fixture/review", mimeType: "text/html" },
      descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
    },
  });
  if (!result.ok || !result.value.instance) throw new Error("Fixture failed to open");
  const instance = result.value.instance;
  const request: RuntimeUiApplicationHostCommand = {
    ...instance.owner,
    instanceId: instance.instanceId,
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const selectSession = vi.fn<RuntimeUiSessionSelectionPorts["selectSession"]>(
    async (_instance, targetSessionId: string | undefined) =>
      targetSessionId ? { grantId: "grant-one", sessionId: targetSessionId } : null,
  );
  const getSelectedSession = vi.fn<RuntimeUiSessionSelectionPorts["getSelectedSession"]>(
    async () => null,
  );
  const searchSessions = vi.fn<NonNullable<RuntimeUiSessionSelectionPorts["searchSessions"]>>(
    async (_instance, query, limit) =>
      [
        { id: `session:${query}`, name: "Pull Requests", updatedAt: "2026-09-11T00:00:00.000Z" },
        { id: "session:second", name: "Second" },
      ].slice(0, limit),
  );
  registerRuntimeUiSessionSelectionHandlers({
    controller,
    selectSession,
    getSelectedSession,
    searchSessions,
    ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => {
      handlers.set(channel, testDouble<(...args: unknown[]) => unknown>(handler));
    },
  });
  return {
    request,
    selectSession,
    getSelectedSession,
    searchSessions,
    instance,
    controller,
    invoke: (channel: string, input: unknown) => handlers.get(channel)!(undefined, input),
  };
}

describe("runtime UI selected session binding", () => {
  it("passes the authoritative owned instance to native grant callbacks and clears explicitly", async () => {
    const h = await harness();
    expect(
      await h.invoke("runtime-ui:selectSession", { ...h.request, targetSessionId: "target" }),
    ).toEqual({ success: true, value: { grantId: "grant-one", sessionId: "target" } });
    expect(h.selectSession).toHaveBeenCalledWith(h.instance, "target");
    expect(await h.invoke("runtime-ui:selectSession", h.request)).toEqual({
      success: true,
      value: null,
    });
    expect(h.selectSession).toHaveBeenLastCalledWith(h.instance, undefined);
  });

  it("rejects foreign owner/session scopes and invalidated instances before touching grants", async () => {
    const h = await harness();
    expect(
      await h.invoke("runtime-ui:selectSession", {
        ...h.request,
        extensionId: "foreign",
        targetSessionId: "target",
      }),
    ).toMatchObject({ success: false });
    expect(
      await h.invoke("runtime-ui:getSelectedSession", {
        ...h.request,
        applicationScope: "workspace",
      }),
    ).toMatchObject({ success: false });
    h.controller.invalidateOwner(h.instance.owner);
    expect(await h.invoke("runtime-ui:getSelectedSession", h.request)).toMatchObject({
      success: false,
    });
    expect(h.selectSession).not.toHaveBeenCalled();
    expect(h.getSelectedSession).not.toHaveBeenCalled();
  });

  it("provides bounded host-owned search results with stable session identities", async () => {
    const h = await harness();
    expect(
      await h.invoke("runtime-ui:searchSessions", {
        ...h.request,
        query: "  acme ",
        limit: 1,
      }),
    ).toEqual({
      success: true,
      value: [
        {
          sessionId: "session:  acme ",
          title: "Pull Requests",
          updatedAt: "2026-09-11T00:00:00.000Z",
        },
      ],
    });
    expect(h.searchSessions).toHaveBeenCalledWith(h.instance, "  acme ", 1);
    expect(
      await h.invoke("runtime-ui:searchSessions", {
        ...h.request,
        query: "x".repeat(400),
        limit: 100,
      }),
    ).toMatchObject({ success: true });
    expect(h.searchSessions).toHaveBeenLastCalledWith(h.instance, "x".repeat(256), 20);
  });
});
