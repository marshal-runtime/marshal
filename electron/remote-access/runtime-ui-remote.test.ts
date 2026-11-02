/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Test registers real handlers and exercises the type-erased remote dispatch boundary. */
import { createRuntimeServiceContainer } from "@marshal/runtime";
import {
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  type RuntimeExtensionUiPublicationService,
  type RuntimeExtensionUiPublishedApplication,
  type RuntimeExtensionUiPublishedPlacement,
} from "@marshal/runtime/extensions";
import { describe, expect, it, vi } from "vitest";

import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import {
  RUNTIME_UI_PLACEMENT,
  RUNTIME_UI_USER_SCOPE,
  runtimeExtensionPlacementId,
} from "../../common/runtime-ui";
import { registerRuntimeUiHandlers } from "../ipc/runtime-ui-ipc";
import { MarshalRuntimeUiController, type RuntimeUiDeliveryPorts } from "../marshal-runtime";
import type { MarshalRuntimeApi } from "../marshal-runtime/contracts";
import { testDouble } from "../testing/harness";
import { validateRemoteArgs } from "./policy";
import {
  invokeSharedHandler,
  type RemoteEventSender,
} from "./shared-handlers";

const publishedApplication: RuntimeExtensionUiPublishedApplication = {
  id: "codereview.prs",
  ownerId: "@marshal/code-review",
  revisionId: "revision-1",
  title: "Pull Requests",
  description: "Review pull requests",
  renderId: "codereview-prs",
  resource: {
    uri: "ui://code-review/prs",
    mimeType: "text/html",
    text: "<!doctype html><html><body><main>Pull requests</main></body></html>",
  },
  // Deliberate declaration on the existing publication metadata record — the
  // ONLY activation signal (document markup never counts: the runtime stamps
  // a responsive viewport meta on every compiled wrapper).
  metadata: { "marshal.ui.viewports": ["mobile", "desktop"] },
  application: {
    version: "1.0.0",
    presentationModes: ["inline", "fullscreen"],
    actions: [
      {
        id: "list-prs",
        version: "1.0.0",
        title: "List pull requests",
        description: "List open pull requests",
        target: { kind: "capability", capability: "codereview-list-prs" },
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        allowedScopes: ["session"],
        requiredPermissions: ["runtime.read"],
        risk: "read",
        idempotency: "supported",
      },
    ],
    tools: [],
  },
} as RuntimeExtensionUiPublishedApplication;

const publishedPlacement: RuntimeExtensionUiPublishedPlacement = {
  ownerId: publishedApplication.ownerId,
  revisionId: publishedApplication.revisionId,
  placementId: runtimeExtensionPlacementId(RUNTIME_UI_PLACEMENT.NAV_PRIMARY),
  action: "augment",
  applicationId: publishedApplication.id,
};

function remoteSender(id: number) {
  const destroyed: Array<() => void> = [];
  const send = vi.fn<(channel: string, ...args: unknown[]) => void>();
  let open = true;
  const sender: RemoteEventSender = {
    id,
    isDestroyed: () => !open,
    send,
    once: (_event, listener) => {
      destroyed.push(listener);
    },
    removeListener: (_event, listener) => {
      const at = destroyed.indexOf(listener);
      if (at >= 0) destroyed.splice(at, 1);
    },
  };
  return {
    sender,
    send,
    destroy() {
      open = false;
      for (const listener of [...destroyed]) listener();
    },
  };
}

async function createHarness(
  runtimeApi?: MarshalRuntimeApi,
  invokeApplicationCapability?: Parameters<
    typeof registerRuntimeUiHandlers
  >[0]["invokeApplicationCapability"],
) {
  const delivery: RuntimeUiDeliveryPorts = {
    notification: vi.fn<RuntimeUiDeliveryPorts["notification"]>(),
    chatMessage: vi.fn<RuntimeUiDeliveryPorts["chatMessage"]>(),
    chatCard: vi.fn<RuntimeUiDeliveryPorts["chatCard"]>(),
  };
  const controller = new MarshalRuntimeUiController(
    () => Date.parse("2026-09-13T08:00:00.000Z"),
    (request) => ({ allowed: true, scope: request.scope }),
    delivery,
  );
  const serviceContainer = createRuntimeServiceContainer();
  await serviceContainer.bind(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
    useValue: testDouble<RuntimeExtensionUiPublicationService>({
      listApplications: vi
        .fn<RuntimeExtensionUiPublicationService["listApplications"]>()
        .mockResolvedValue([publishedApplication]),
      resolvePlacementState: vi
        .fn<RuntimeExtensionUiPublicationService["resolvePlacementState"]>()
        .mockResolvedValue({ placements: [publishedPlacement] }),
    }),
  });
  const desktopHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const dispose = registerRuntimeUiHandlers({
    controller,
    serviceContainer,
    ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => {
      desktopHandlers.set(channel, handler as (...args: unknown[]) => unknown);
    },
    runtimeApi,
    invokeApplicationCapability,
  });
  return { controller, dispose, desktopHandlers };
}

describe("remote runtime-ui policy", () => {
  it("allowlists the mobile runtime-ui read/open surface", () => {
    expect(() =>
      validateRemoteArgs("runtime-ui:getPlacements", [RUNTIME_UI_USER_SCOPE]),
    ).not.toThrow();
    expect(() =>
      validateRemoteArgs("runtime-ui:getSnapshot", [RUNTIME_UI_USER_SCOPE]),
    ).not.toThrow();
    expect(() =>
      validateRemoteArgs("runtime-ui:activatePlacement", [
        {
          ...RUNTIME_UI_USER_SCOPE,
          placementId: RUNTIME_UI_PLACEMENT.NAV_PRIMARY,
          extensionId: "@marshal/code-review",
          applicationId: "codereview.prs",
          idempotencyKey: "remote-navigation:1",
        },
      ]),
    ).not.toThrow();
    expect(() =>
      validateRemoteArgs("runtime-ui:invokeCapability", [
        {
          ...RUNTIME_UI_USER_SCOPE,
          extensionId: "@marshal/code-review",
          applicationId: "codereview.prs",
          instanceId: "instance-1",
          capability: "codereview-list-prs",
          publicationRevisionId: "revision-1",
          input: { page: 1 },
          idempotencyKey: "remote-invoke:1",
        },
      ]),
    ).not.toThrow();
    expect(() =>
      validateRemoteArgs("runtime-ui:readResource", [
        {
          ...RUNTIME_UI_USER_SCOPE,
          extensionId: "@marshal/code-review",
          applicationId: "codereview.prs",
          instanceId: "instance-1",
          uri: "ui://code-review/prs",
        },
      ]),
    ).not.toThrow();
  });

  it("rejects malformed runtime-ui scopes at the network boundary", () => {
    expect(() => validateRemoteArgs("runtime-ui:getPlacements", [{}])).toThrow(
      "Invalid arguments",
    );
    expect(() =>
      validateRemoteArgs("runtime-ui:getPlacements", [
        { workspaceName: "marshal", applicationScope: "user", extra: true },
      ]),
    ).toThrow("Invalid arguments");
  });

  it("keeps raw surface mutation desktop-only", () => {
    for (const channel of ["runtime-ui:open", "runtime-ui:update"]) {
      expect(() => validateRemoteArgs(channel, [{}])).toThrow(
        "This action is available only on the Mac.",
      );
    }
  });
});

describe("remote runtime-ui dispatch", () => {
  it("serves placements and snapshots through the shared publication reads", async () => {
    const { dispose } = await createHarness();
    const placements = (await invokeSharedHandler(
      "runtime-ui:getPlacements",
      [RUNTIME_UI_USER_SCOPE],
      remoteSender(-1).sender,
    )) as { placements: readonly { metadata: { id: string }; applications: readonly unknown[] }[] };
    const nav = placements.placements.find(
      (placement) => placement.metadata.id === RUNTIME_UI_PLACEMENT.NAV_PRIMARY,
    );
    expect(nav?.applications).toEqual([
      expect.objectContaining({
        applicationId: "codereview.prs",
        title: "Pull Requests",
        // Presence signal for the phone: the published document declares it
        // serves the mobile viewport, so the mobile nav may list it.
        viewports: expect.arrayContaining(["mobile", "desktop"]),
      }),
    ]);
    dispose();
  });

  it("refuses sender-scoped runtime-ui operations without a remote sender", async () => {
    const { dispose } = await createHarness();
    await expect(
      invokeSharedHandler("runtime-ui:subscribe", [RUNTIME_UI_USER_SCOPE]),
    ).rejects.toThrow("Remote operation requires a connected device");
    dispose();
  });

  it("routes runtime-ui events only to senders subscribed to the owning scope", async () => {
    const { controller, dispose } = await createHarness();
    const subscribedScope = remoteSender(-1);
    const foreignScope = remoteSender(-2);
    await invokeSharedHandler(
      "runtime-ui:subscribe",
      [RUNTIME_UI_USER_SCOPE],
      subscribedScope.sender,
    );
    await invokeSharedHandler(
      "runtime-ui:subscribe",
      [{ sessionId: "session-other", workspaceName: "marshal" }],
      foreignScope.sender,
    );
    const opened = await controller.open({
      ...RUNTIME_UI_USER_SCOPE,
      extensionId: publishedApplication.ownerId,
      applicationId: publishedApplication.id,
      surface: "tab",
      content: {
        kind: "application",
        renderId: publishedApplication.renderId,
        resource: {
          uri: publishedApplication.resource.uri,
          mimeType: "text/html",
          name: publishedApplication.title,
        },
        descriptor: publishedApplication.application,
      },
      idempotencyKey: "remote-open:1",
    });
    expect(opened.ok).toBe(true);
    expect(subscribedScope.send).toHaveBeenCalledWith(
      "runtime-ui:event",
      expect.objectContaining({ type: "instance-opened" }),
    );
    expect(foreignScope.send).not.toHaveBeenCalled();
    dispose();
  });

  it("drops a remote subscription when its socket closes", async () => {
    const { controller, dispose } = await createHarness();
    const closing = remoteSender(-3);
    await invokeSharedHandler("runtime-ui:subscribe", [RUNTIME_UI_USER_SCOPE], closing.sender);
    closing.destroy();
    const opened = await controller.open({
      ...RUNTIME_UI_USER_SCOPE,
      extensionId: publishedApplication.ownerId,
      applicationId: publishedApplication.id,
      surface: "tab",
      content: {
        kind: "application",
        renderId: publishedApplication.renderId,
        resource: {
          uri: publishedApplication.resource.uri,
          mimeType: "text/html",
          name: publishedApplication.title,
        },
        descriptor: publishedApplication.application,
      },
      idempotencyKey: "remote-open:2",
    });
    expect(opened.ok).toBe(true);
    expect(closing.send).not.toHaveBeenCalledWith(
      "runtime-ui:event",
      expect.objectContaining({ type: "instance-opened" }),
    );
    dispose();
  });

  it("enforces the publication capability pin on the remote invoke path", async () => {
    const invoke = vi.fn<MarshalRuntimeApi["invoke"]>().mockResolvedValue({
      ok: true,
      value: { output: { entries: [] } },
    } as Awaited<ReturnType<MarshalRuntimeApi["invoke"]>>);
    const { controller, dispose } = await createHarness(
      testDouble<MarshalRuntimeApi>({ invoke }),
      // User-scoped applications execute through the host's application
      // capability port, exactly as main.ts wires runtimeApplicationHost.
      (_instance, request, signal) =>
        invoke({
          sessionId: "session-bound",
          workspaceName: request.workspaceName,
          capability: request.capability,
          input: request.input,
          idempotencyKey: request.idempotencyKey,
          origin: "runtime-ui",
          signal,
        }),
    );
    const opened = await controller.open({
      ...RUNTIME_UI_USER_SCOPE,
      extensionId: publishedApplication.ownerId,
      applicationId: publishedApplication.id,
      surface: "tab",
      content: {
        kind: "application",
        renderId: publishedApplication.renderId,
        resource: {
          uri: publishedApplication.resource.uri,
          mimeType: "text/html",
          name: publishedApplication.title,
        },
        descriptor: publishedApplication.application,
      },
      idempotencyKey: "remote-open:3",
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const instanceId = opened.value.instance!.instanceId;
    const { sender } = remoteSender(-4);
    const denied = (await invokeSharedHandler(
      "runtime-ui:invokeCapability",
      [
        {
          ...RUNTIME_UI_USER_SCOPE,
          extensionId: publishedApplication.ownerId,
          applicationId: publishedApplication.id,
          instanceId,
          capability: "some-other-extension-capability",
          publicationRevisionId: publishedApplication.revisionId,
          idempotencyKey: "remote-invoke:denied",
        },
      ],
      sender,
    )) as { success: boolean; error?: { code: string } };
    expect(denied.success).toBe(false);
    expect(denied.error?.code).toBe("permission-denied");
    expect(invoke).not.toHaveBeenCalled();
    const allowed = (await invokeSharedHandler(
      "runtime-ui:invokeCapability",
      [
        {
          ...RUNTIME_UI_USER_SCOPE,
          extensionId: publishedApplication.ownerId,
          applicationId: publishedApplication.id,
          instanceId,
          capability: "codereview-list-prs",
          publicationRevisionId: publishedApplication.revisionId,
          idempotencyKey: "remote-invoke:allowed",
        },
      ],
      sender,
    )) as { success: boolean };
    expect(allowed.success).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("reads only the published application resource over the remote path", async () => {
    const { controller, dispose } = await createHarness();
    const opened = await controller.open({
      ...RUNTIME_UI_USER_SCOPE,
      extensionId: publishedApplication.ownerId,
      applicationId: publishedApplication.id,
      surface: "tab",
      content: {
        kind: "application",
        renderId: publishedApplication.renderId,
        resource: {
          uri: publishedApplication.resource.uri,
          mimeType: "text/html",
          name: publishedApplication.title,
        },
        descriptor: publishedApplication.application,
      },
      idempotencyKey: "remote-open:4",
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const instanceId = opened.value.instance!.instanceId;
    const { sender } = remoteSender(-5);
    const resource = (await invokeSharedHandler(
      "runtime-ui:readResource",
      [
        {
          ...RUNTIME_UI_USER_SCOPE,
          extensionId: publishedApplication.ownerId,
          applicationId: publishedApplication.id,
          instanceId,
          uri: publishedApplication.resource.uri,
        },
      ],
      sender,
    )) as { success: boolean; value?: { text?: string } };
    expect(resource.success).toBe(true);
    expect(resource.value?.text).toContain("Pull requests");
    const foreign = (await invokeSharedHandler(
      "runtime-ui:readResource",
      [
        {
          ...RUNTIME_UI_USER_SCOPE,
          extensionId: publishedApplication.ownerId,
          applicationId: publishedApplication.id,
          instanceId,
          uri: "file:///Users/omer/.marshal/marshal-codex/auth.json",
        },
      ],
      sender,
    )) as { success: boolean; error?: { code: string } };
    expect(foreign.success).toBe(false);
    expect(foreign.error?.code).toBe("permission-denied");
    dispose();
  });
});

describe("M2: focus origin stamping (remote activation must not drive the desktop pane)", () => {
  it("stamps instances opened through a remote activation as remotely focused", async () => {
    const { dispose } = await createHarness();
    const { sender } = remoteSender(-8);
    const result = (await invokeSharedHandler(
      "runtime-ui:activatePlacement",
      [
        {
          ...RUNTIME_UI_USER_SCOPE,
          placementId: RUNTIME_UI_PLACEMENT.NAV_PRIMARY,
          extensionId: publishedApplication.ownerId,
          applicationId: publishedApplication.id,
          idempotencyKey: "remote-navigation:m2-open",
        },
      ],
      sender,
    )) as { success: boolean; value?: { instance?: { focusedBy?: string } } };
    expect(result.success).toBe(true);
    expect(result.value?.instance?.focusedBy).toBe("remote");
    dispose();
  });

  it("stamps desktop activations as desktop-focused and remote focus of an existing instance as remote", async () => {
    const { controller, dispose, desktopHandlers } = await createHarness();
    const desktopEvent = { sender: { id: 7 } };
    const activated = (await desktopHandlers.get("runtime-ui:activatePlacement")!(
      desktopEvent,
      {
        ...RUNTIME_UI_USER_SCOPE,
        placementId: RUNTIME_UI_PLACEMENT.NAV_PRIMARY,
        extensionId: publishedApplication.ownerId,
        applicationId: publishedApplication.id,
        idempotencyKey: "desktop-navigation:m2",
      },
    )) as { success: boolean; value?: { instance?: { instanceId: string; focusedBy?: string } } };
    expect(activated.success).toBe(true);
    expect(activated.value?.instance?.focusedBy).toBe("desktop");
    const instanceId = activated.value!.instance!.instanceId;
    const { sender } = remoteSender(-9);
    const focused = (await invokeSharedHandler(
      "runtime-ui:focus",
      [
        {
          ...RUNTIME_UI_USER_SCOPE,
          extensionId: publishedApplication.ownerId,
          applicationId: publishedApplication.id,
          instanceId,
          idempotencyKey: "remote-focus:m2",
        },
      ],
      sender,
    )) as { success: boolean; value?: { instance?: { focusedBy?: string } } };
    expect(focused.success).toBe(true);
    expect(focused.value?.instance?.focusedBy).toBe("remote");
    const listed = await controller.list({ ...RUNTIME_UI_USER_SCOPE });
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.value.instances?.[0]?.focusedBy).toBe("remote");
    dispose();
  });

  it("never trusts a client-claimed origin: the dispatching surface wins", async () => {
    const { dispose } = await createHarness();
    const { sender } = remoteSender(-10);
    // A remote caller claiming origin "desktop" is rejected at the policy
    // boundary (strict schema), so it can never spoof a desktop focus.
    expect(() =>
      validateRemoteArgs("runtime-ui:activatePlacement", [
        {
          ...RUNTIME_UI_USER_SCOPE,
          placementId: RUNTIME_UI_PLACEMENT.NAV_PRIMARY,
          extensionId: publishedApplication.ownerId,
          applicationId: publishedApplication.id,
          idempotencyKey: "spoof",
          origin: "desktop",
        },
      ]),
    ).toThrow("Invalid arguments");
    // And even through direct dispatch the handler overrides any smuggled field.
    const result = (await invokeSharedHandler(
      "runtime-ui:activatePlacement",
      [
        {
          ...RUNTIME_UI_USER_SCOPE,
          placementId: RUNTIME_UI_PLACEMENT.NAV_PRIMARY,
          extensionId: publishedApplication.ownerId,
          applicationId: publishedApplication.id,
          idempotencyKey: "remote-navigation:m2-override",
        },
      ],
      sender,
    )) as { success: boolean; value?: { instance?: { focusedBy?: string } } };
    expect(result.value?.instance?.focusedBy).toBe("remote");
    dispose();
  });
});
