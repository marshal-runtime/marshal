import { createRuntimeServiceContainer } from "@marshal/runtime";
import {
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  type RuntimeExtensionUiPublicationService,
  type RuntimeExtensionUiPublishedApplication,
} from "@marshal/runtime/extensions";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import { RUNTIME_UI_USER_SCOPE } from "../../common/runtime-ui";
import {
  MarshalRuntimeUiController,
  type RuntimeUiDeliveryPorts,
} from "../marshal-runtime/ui-controller";
import { testDouble } from "../testing/harness";
import { registerRuntimeUiHandlers } from "./runtime-ui-ipc";

async function harness() {
  let apps: RuntimeExtensionUiPublishedApplication[] = ["zeta", "alpha"].map((id) => ({
    id,
    ownerId: `fixture.${id}`,
    revisionId: "v1",
    title: id,
    description: id,
    renderId: id,
    resource: { uri: `ui://${id}/app`, mimeType: "text/html", text: `<h1>${id}</h1>` },
    application: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
  }));
  const publication = testDouble<RuntimeExtensionUiPublicationService>({
    listApplications: vi.fn<RuntimeExtensionUiPublicationService["listApplications"]>(
      async () => apps,
    ),
    resolvePlacementState: vi.fn<RuntimeExtensionUiPublicationService["resolvePlacementState"]>(
      async () => ({
        placements: apps.map((app) => ({
          ownerId: app.ownerId,
          revisionId: app.revisionId,
          applicationId: app.id,
          placementId: "nav.primary",
          action: "augment" as const,
        })),
      }),
    ),
  });
  const serviceContainer = createRuntimeServiceContainer();
  await serviceContainer.bind(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, { useValue: publication });
  const controller = new MarshalRuntimeUiController(
    () => Date.now(),
    (request) => ({ allowed: true, scope: request.scope }),
    {
      notification: vi.fn<RuntimeUiDeliveryPorts["notification"]>(),
      chatMessage: vi.fn<RuntimeUiDeliveryPorts["chatMessage"]>(),
      chatCard: vi.fn<RuntimeUiDeliveryPorts["chatCard"]>(),
    },
  );
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const send = vi.fn<WebContents["send"]>();
  const sender = testDouble<WebContents>({
    id: 1,
    send,
    isDestroyed: () => false,
    once: vi.fn<WebContents["once"]>(),
  });
  const dispose = registerRuntimeUiHandlers({
    ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => {
      handlers.set(channel, testDouble<(...args: unknown[]) => unknown>(handler));
    },
    controller,
    serviceContainer,
  });
  return {
    controller,
    publication,
    send,
    dispose,
    apps,
    disable(id: string) {
      apps = apps.filter((app) => app.id !== id);
      controller.invalidateOwner({ extensionId: `fixture.${id}`, applicationId: id });
    },
    restore(app: RuntimeExtensionUiPublishedApplication) {
      apps.push(app);
    },
    invoke<C extends keyof IpcInvokeMap>(
      channel: C,
      ...args: Parameters<IpcInvokeMap[C]>
    ): ReturnType<IpcInvokeMap[C]> {
      const handler = testDouble<
        (
          event: { sender: WebContents },
          ...args: Parameters<IpcInvokeMap[C]>
        ) => ReturnType<IpcInvokeMap[C]>
      >(handlers.get(channel)!);
      return handler({ sender }, ...args);
    },
  };
}

describe("runtime UI navigation", () => {
  it("opens and focuses independent entries with no selected session and restores without duplicates", async () => {
    const h = await harness();
    const snapshot = await h.invoke("runtime-ui:getPlacements", RUNTIME_UI_USER_SCOPE);
    expect(
      snapshot.placements
        .find((placement) => placement.metadata.id === "nav.primary")
        ?.applications.map((app) => app.applicationId),
    ).toEqual(["alpha", "zeta"]);
    const request = {
      ...RUNTIME_UI_USER_SCOPE,
      placementId: "nav.primary",
      extensionId: "fixture.alpha",
      applicationId: "alpha",
      idempotencyKey: "open-alpha",
    };
    const opened = await h.invoke("runtime-ui:activatePlacement", request);
    expect(opened).toMatchObject({
      success: true,
      value: { instance: { owner: { applicationScope: "user" }, surface: "tab" } },
    });
    const focused = await h.invoke("runtime-ui:activatePlacement", {
      ...request,
      idempotencyKey: "focus-alpha",
    });
    expect(focused.success && focused.value.instance?.instanceId).toBe(
      opened.success && opened.value.instance?.instanceId,
    );
    h.disable("alpha");
    expect(
      await h.invoke("runtime-ui:activatePlacement", { ...request, idempotencyKey: "stale-alpha" }),
    ).toMatchObject({ success: false });
    h.restore(h.apps.find((app) => app.id === "alpha")!);
    const restored = await h.invoke("runtime-ui:activatePlacement", {
      ...request,
      idempotencyKey: "restore-alpha",
    });
    expect(restored.success).toBe(true);
    const state = await h.controller.snapshot(RUNTIME_UI_USER_SCOPE);
    expect(state.ok && state.value.instances).toHaveLength(1);
    h.dispose();
  });

  it("serializes concurrent activations to one owned application instance", async () => {
    const h = await harness();
    const request = {
      ...RUNTIME_UI_USER_SCOPE,
      placementId: "nav.primary",
      extensionId: "fixture.alpha",
      applicationId: "alpha",
    };
    const results = await Promise.all(
      ["first", "second"].map((idempotencyKey) =>
        h.invoke("runtime-ui:activatePlacement", { ...request, idempotencyKey }),
      ),
    );
    expect(results.every((result) => result.success)).toBe(true);
    const state = await h.controller.snapshot(RUNTIME_UI_USER_SCOPE);
    expect(state.ok && state.value.instances).toHaveLength(1);
    h.dispose();
  });

  it("subscribes to persistent apps and the current chat independently", async () => {
    const h = await harness();
    const sessionScope = { sessionId: "chat-one", workspaceName: "marshal" };
    await h.invoke("runtime-ui:subscribe", RUNTIME_UI_USER_SCOPE);
    await h.invoke("runtime-ui:subscribe", sessionScope);
    await h.invoke("runtime-ui:unsubscribe", sessionScope);
    await h.invoke("runtime-ui:activatePlacement", {
      ...RUNTIME_UI_USER_SCOPE,
      placementId: "nav.primary",
      extensionId: "fixture.alpha",
      applicationId: "alpha",
      idempotencyKey: "app-open",
    });
    expect(h.send).toHaveBeenCalledWith(
      "runtime-ui:event",
      expect.objectContaining({ type: "instance-opened", scope: RUNTIME_UI_USER_SCOPE }),
    );
    h.send.mockClear();
    await h.controller.open({
      ...sessionScope,
      extensionId: "fixture.alpha",
      applicationId: "alpha",
      surface: "panel",
      content: { kind: "text", text: "session" },
      idempotencyKey: "chat-open",
    });
    expect(h.send).not.toHaveBeenCalled();
    h.dispose();
  });
});
