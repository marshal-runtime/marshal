import { createRuntimeServiceContainer } from "@marshal/runtime";
import {
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  type RuntimeExtensionUiPublicationService,
  type RuntimeExtensionUiPublishedApplication,
  type RuntimeExtensionUiPublishedPlacement,
} from "@marshal/runtime/extensions";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import { MarshalRuntimeUiController, type RuntimeUiDeliveryPorts } from "../marshal-runtime";
import type { MarshalRuntimeApi } from "../marshal-runtime/contracts";
import { testDouble } from "../testing/harness";
import { registerRuntimeUiHandlers } from "./runtime-ui-ipc";

type RegisteredHandler = (...args: unknown[]) => unknown;

const scope = { sessionId: "session-1", workspaceName: "workspace-1" };
const COMPOSER_ADD_PLACEMENT_ID = "chat.composer.add";

function composerAddPlacementIndex(snapshot: unknown): number {
  const placements =
    typeof snapshot === "object" && snapshot !== null && "placements" in snapshot
      ? snapshot.placements
      : [];
  if (!Array.isArray(placements)) return -1;
  return placements.findIndex(
    (placement: unknown) =>
      typeof placement === "object" &&
      placement !== null &&
      "metadata" in placement &&
      typeof placement.metadata === "object" &&
      placement.metadata !== null &&
      "id" in placement.metadata &&
      placement.metadata.id === COMPOSER_ADD_PLACEMENT_ID,
  );
}
const publishedApplication: RuntimeExtensionUiPublishedApplication = {
  id: "overlay-review",
  ownerId: "@fixture/overlay",
  revisionId: "revision-1",
  title: "Review on screen",
  description: "Review the current screen",
  renderId: "overlay-review",
  resource: {
    uri: "ui://fixture/overlay-review",
    mimeType: "text/html",
    text: "<main>Review</main>",
  },
  application: {
    version: "1.0.0",
    presentationModes: ["inline", "pip"],
    actions: [],
    tools: [],
  },
};
const publishedPlacement: RuntimeExtensionUiPublishedPlacement = {
  ownerId: publishedApplication.ownerId,
  revisionId: publishedApplication.revisionId,
  placementId: "marshal.chat.composer.add",
  action: "augment",
  applicationId: publishedApplication.id,
};

function sender(id: number) {
  const destroyed: Array<() => void> = [];
  const isDestroyed = vi.fn<() => boolean>(() => false);
  const send = vi.fn<(channel: string, ...args: unknown[]) => void>();
  const once = vi.fn<(event: string, callback: () => void) => WebContents>();
  const value = testDouble<WebContents>({
    id,
    isDestroyed,
    send,
    once,
  });
  once.mockImplementation((event, callback) => {
    if (event === "destroyed") destroyed.push(callback);
    return value;
  });
  return { value, destroyed, send };
}

function publication(
  application: RuntimeExtensionUiPublishedApplication = publishedApplication,
): RuntimeExtensionUiPublicationService {
  const placement: RuntimeExtensionUiPublishedPlacement = {
    ...publishedPlacement,
    ownerId: application.ownerId,
    revisionId: application.revisionId,
    applicationId: application.id,
  };
  return testDouble<RuntimeExtensionUiPublicationService>({
    listApplications: vi
      .fn<RuntimeExtensionUiPublicationService["listApplications"]>()
      .mockResolvedValue([application]),
    resolvePlacementState: vi
      .fn<RuntimeExtensionUiPublicationService["resolvePlacementState"]>()
      .mockResolvedValue({
        placements: [placement],
      }),
  });
}

async function createHarness(options?: {
  readonly application?: RuntimeExtensionUiPublishedApplication;
  readonly runtimeApi?: MarshalRuntimeApi;
}) {
  let denied = false;
  const delivery: RuntimeUiDeliveryPorts = {
    notification: vi.fn<RuntimeUiDeliveryPorts["notification"]>(),
    chatMessage: vi.fn<RuntimeUiDeliveryPorts["chatMessage"]>(),
    chatCard: vi.fn<RuntimeUiDeliveryPorts["chatCard"]>(),
  };
  const controller = new MarshalRuntimeUiController(
    () => Date.parse("2026-08-14T08:00:00.000Z"),
    (request) =>
      denied ? { allowed: false, reason: "blocked" } : { allowed: true, scope: request.scope },
    delivery,
  );
  const serviceContainer = createRuntimeServiceContainer();
  const initialPublication = publication(options?.application);
  await serviceContainer.bind(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
    useValue: initialPublication,
  });
  const handlers = new Map<string, RegisteredHandler>();
  const dispose = registerRuntimeUiHandlers({
    controller,
    serviceContainer,
    ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => {
      handlers.set(channel, testDouble<RegisteredHandler>(handler));
    },
    runtimeApi: options?.runtimeApi,
  });
  return {
    controller,
    serviceContainer,
    initialPublication,
    dispose,
    handlers,
    deny() {
      denied = true;
    },
  };
}

describe("Runtime UI IPC", () => {
  it("subscribes with reconnect snapshots and forwards each subscribed scope", async () => {
    const { controller, dispose, handlers } = await createHarness();
    const first = sender(1);
    const event = { sender: first.value };
    const sessionOne = { sessionId: "session-1", workspaceName: "workspace-1" };
    const sessionTwo = { sessionId: "session-2", workspaceName: "workspace-1" };

    await expect(handlers.get("runtime-ui:subscribe")!(event, sessionOne)).resolves.toMatchObject({
      success: true,
      value: { scope: sessionOne, instances: [] },
    });
    await controller.open({
      ...sessionOne,
      extensionId: "extension",
      applicationId: "application",
      surface: "panel",
      content: { kind: "text", text: "one" },
      idempotencyKey: "one",
    });
    expect(first.send).toHaveBeenCalledWith(
      "runtime-ui:event",
      expect.objectContaining({ type: "instance-opened", scope: sessionOne }),
    );

    await expect(handlers.get("runtime-ui:subscribe")!(event, sessionTwo)).resolves.toMatchObject({
      success: true,
      value: { scope: sessionTwo },
    });
    first.send.mockClear();
    await controller.open({
      ...sessionOne,
      extensionId: "extension",
      applicationId: "application",
      surface: "tab",
      content: { kind: "text", text: "old scope" },
      idempotencyKey: "old-scope",
    });
    await controller.open({
      ...sessionTwo,
      extensionId: "extension",
      applicationId: "application",
      surface: "tab",
      content: { kind: "text", text: "new scope" },
      idempotencyKey: "new-scope",
    });
    expect(first.send).toHaveBeenCalledTimes(2);
    expect(first.send).toHaveBeenCalledWith(
      "runtime-ui:event",
      expect.objectContaining({ scope: sessionTwo }),
    );

    expect(handlers.get("runtime-ui:unsubscribe")!(event)).toEqual({
      success: true,
    });
    dispose();
  });

  it("maps scoped commands and typed permission denial without an arbitrary dispatch channel", async () => {
    const { deny, handlers } = await createHarness();
    expect([...handlers.keys()].sort()).toEqual([
      "runtime-ui:activatePlacement",
      "runtime-ui:cancelCapability",
      "runtime-ui:close",
      "runtime-ui:focus",
      "runtime-ui:getEvidence",
      "runtime-ui:getPlacements",
      "runtime-ui:getSnapshot",
      "runtime-ui:invokeCapability",
      "runtime-ui:list",
      "runtime-ui:open",
      "runtime-ui:openEvidence",
      "runtime-ui:readResource",
      "runtime-ui:subscribe",
      "runtime-ui:unsubscribe",
      "runtime-ui:update",
    ]);
    const command = {
      sessionId: "session-1",
      workspaceName: "workspace-1",
      extensionId: "extension",
      applicationId: "application",
      surface: "panel" as const,
      content: { kind: "text" as const, text: "one" },
      idempotencyKey: "one",
    };
    await expect(handlers.get("runtime-ui:open")!(undefined, command)).resolves.toMatchObject({
      success: true,
      value: { receipt: { action: "open" } },
    });

    deny();
    await expect(handlers.get("runtime-ui:getSnapshot")!(undefined, scope)).resolves.toEqual({
      success: false,
      error: { code: "permission-denied", message: "blocked" },
    });
  });

  it("resolves published placements at call time and opens or focuses their application", async () => {
    const { controller, handlers, serviceContainer } = await createHarness();

    await expect(
      handlers.get("runtime-ui:getPlacements")!(undefined, scope),
    ).resolves.toMatchObject({
      placements: expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ id: "chat.composer.add" }),
          applications: [
            expect.objectContaining({
              extensionId: publishedApplication.ownerId,
              applicationId: publishedApplication.id,
              title: publishedApplication.title,
              action: "augment",
            }),
          ],
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({ id: "chat.slash-command" }),
          applications: [],
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({ id: "nav.primary" }),
          applications: [],
        }),
      ]),
      diagnostics: [],
    });

    const request = {
      ...scope,
      extensionId: publishedApplication.ownerId,
      applicationId: publishedApplication.id,
      idempotencyKey: "placement-open",
    };
    await expect(
      handlers.get("runtime-ui:activatePlacement")!(undefined, request),
    ).resolves.toMatchObject({
      success: true,
      value: {
        receipt: { action: "open" },
        instance: {
          surface: "panel",
          content: {
            kind: "application",
            renderId: publishedApplication.renderId,
          },
        },
      },
    });
    await expect(
      handlers.get("runtime-ui:activatePlacement")!(undefined, {
        ...request,
        idempotencyKey: "placement-focus",
      }),
    ).resolves.toMatchObject({
      success: true,
      value: { receipt: { action: "focus" } },
    });
    await expect(controller.list(scope)).resolves.toMatchObject({
      ok: true,
      value: { instances: [expect.any(Object)] },
    });

    const replacementApplication = {
      ...publishedApplication,
      title: "Replacement title",
      revisionId: "revision-2",
    };
    await serviceContainer.replace(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
      useValue: publication(replacementApplication),
    });
    await expect(
      handlers.get("runtime-ui:getPlacements")!(undefined, scope),
    ).resolves.toMatchObject({
      placements: expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ id: "chat.composer.add" }),
          applications: [expect.objectContaining({ title: "Replacement title" })],
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({ id: "nav.primary" }),
          applications: [],
        }),
      ]),
    });

    await expect(
      handlers.get("runtime-ui:activatePlacement")!(undefined, {
        ...request,
        unexpected: true,
      }),
    ).resolves.toEqual({
      success: false,
      error: { code: "invalid-request", message: "Invalid placement activation request." },
    });
  });

  it("opens a session placement on the application's declared preferred surface", async () => {
    const { handlers } = await createHarness({
      application: { ...publishedApplication, metadata: { "marshal.ui.preferredSurface": "tab" } },
    });
    await expect(
      handlers.get("runtime-ui:activatePlacement")!(undefined, {
        ...scope,
        extensionId: publishedApplication.ownerId,
        applicationId: publishedApplication.id,
        idempotencyKey: "preferred-tab",
      }),
    ).resolves.toMatchObject({ success: true, value: { instance: { surface: "tab" } } });
    const fallback = await createHarness({
      application: {
        ...publishedApplication,
        metadata: { "marshal.ui.preferredSurface": "window" },
      },
    });
    await expect(
      fallback.handlers.get("runtime-ui:activatePlacement")!(undefined, {
        ...scope,
        extensionId: publishedApplication.ownerId,
        applicationId: publishedApplication.id,
        idempotencyKey: "preferred-unknown",
      }),
    ).resolves.toMatchObject({ success: true, value: { instance: { surface: "panel" } } });
  });

  it("projects the published manifest actions, tools, and publication revision onto placement applications", async () => {
    const manifestAction = (id: string, capability: string) => ({
      id,
      version: "1.0.0",
      title: id,
      target: { kind: "capability" as const, capability },
      inputSchema: {},
      outputSchema: {},
      allowedScopes: ["session" as const],
      requiredPermissions: [],
      risk: "write" as const,
      idempotency: "required" as const,
    });
    const application: RuntimeExtensionUiPublishedApplication = {
      ...publishedApplication,
      revisionId: "revision-7",
      application: {
        ...publishedApplication.application,
        actions: [
          manifestAction("codereview-ai-review", "codereview.ai.review"),
          manifestAction("codereview-thread-applySuggestion", "codereview.thread.applySuggestion"),
        ],
        tools: [
          {
            id: "codereview-babysit-tick",
            name: "codereview.babysit.tick",
            inputSchema: {},
          },
        ],
      },
    };
    const { handlers, dispose } = await createHarness({ application });

    const snapshot = await handlers.get("runtime-ui:getPlacements")!(undefined, scope);
    const addIndex = composerAddPlacementIndex(snapshot);
    expect(snapshot).toHaveProperty(
      `placements[${addIndex}].metadata.id`,
      COMPOSER_ADD_PLACEMENT_ID,
    );
    expect(snapshot).toHaveProperty(`placements[${addIndex}].applications`, [
      {
        extensionId: application.ownerId,
        applicationId: application.id,
        title: application.title,
        description: application.description,
        renderId: application.renderId,
        action: "augment",
        actions: application.application.actions,
        tools: application.application.tools,
        revisionId: "revision-7",
      },
    ]);
    dispose();
  });

  it("projects placement applications without manifest fields when the published record carries no manifest", async () => {
    const application = testDouble<RuntimeExtensionUiPublishedApplication>({
      ...publishedApplication,
      application: undefined,
    });
    const { handlers, dispose } = await createHarness({ application });

    const snapshot = await handlers.get("runtime-ui:getPlacements")!(undefined, scope);
    const addIndex = composerAddPlacementIndex(snapshot);
    expect(snapshot).toHaveProperty(
      `placements[${addIndex}].metadata.id`,
      COMPOSER_ADD_PLACEMENT_ID,
    );
    expect(snapshot).toHaveProperty(`placements[${addIndex}].applications`, [
      {
        extensionId: publishedApplication.ownerId,
        applicationId: publishedApplication.id,
        title: publishedApplication.title,
        description: publishedApplication.description,
        renderId: publishedApplication.renderId,
        action: "augment",
        revisionId: publishedApplication.revisionId,
      },
    ]);
    dispose();
  });

  it("invokes the overlay launch capability without opening a Runtime UI instance", async () => {
    const invoke = vi.fn<MarshalRuntimeApi["invoke"]>().mockResolvedValue({
      ok: true,
      value: {
        output: { launched: true },
        result: { output: { launched: true } },
      },
      receipts: [],
    });
    const application: RuntimeExtensionUiPublishedApplication = {
      ...publishedApplication,
      ownerId: "@marshal/overlay-review",
      renderId: "marshal.overlay-review.v1",
      resource: {
        uri: "runtime://overlay-review/ui/application/v1",
        mimeType: "text/plain",
        text: "",
      },
      application: {
        version: "1.0.0",
        presentationModes: ["inline"],
        actions: [
          {
            id: "launch",
            version: "1.0.0",
            target: { kind: "capability", capability: "overlay.review.launch" },
            inputSchema: {
              type: "object",
              properties: { sessionId: { type: "string", minLength: 1 } },
              required: ["sessionId"],
              additionalProperties: false,
            },
            outputSchema: {},
            allowedScopes: ["session"],
            requiredPermissions: [],
            risk: "external-effect",
            idempotency: "required",
          },
        ],
        tools: [],
      },
    };
    const runtimeApi = testDouble<MarshalRuntimeApi>({ invoke });
    const { controller, handlers } = await createHarness({ application, runtimeApi });

    await expect(
      handlers.get("runtime-ui:activatePlacement")!(undefined, {
        ...scope,
        extensionId: application.ownerId,
        applicationId: application.id,
        idempotencyKey: "overlay-launch",
      }),
    ).resolves.toMatchObject({
      success: true,
      value: { receipt: { action: "list" }, instances: [] },
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: scope.sessionId,
        capability: "overlay.review.launch",
        input: { sessionId: scope.sessionId },
      }),
    );
    await expect(controller.list(scope)).resolves.toMatchObject({
      ok: true,
      value: { instances: [] },
    });
  });

  it("invokes the first declared capability when placement input is provided", async () => {
    const invoke = vi.fn<MarshalRuntimeApi["invoke"]>().mockResolvedValue({
      ok: true,
      value: {
        output: { started: true },
        result: { output: { started: true } },
      },
      receipts: [],
    });
    const capability = "fixture.runs.create";
    const application: RuntimeExtensionUiPublishedApplication = {
      ...publishedApplication,
      ownerId: "@marshal/fixture-extension",
      id: "fixture-cmd",
      renderId: "fixture.view",
      application: {
        version: "1.0.0",
        presentationModes: ["inline"],
        actions: [
          {
            id: "create",
            version: "1.0.0",
            target: { kind: "capability", capability },
            inputSchema: {
              type: "object",
              properties: {
                argument: { type: "string", minLength: 1 },
                fresh: { type: "boolean" },
                sessionId: { type: "string", minLength: 1 },
              },
              additionalProperties: false,
            },
            outputSchema: {},
            allowedScopes: ["session"],
            requiredPermissions: [],
            risk: "write",
            idempotency: "required",
          },
        ],
        tools: [],
      },
    };
    const runtimeApi = testDouble<MarshalRuntimeApi>({ invoke });
    const { controller, handlers } = await createHarness({ application, runtimeApi });

    await expect(
      handlers.get("runtime-ui:activatePlacement")!(undefined, {
        ...scope,
        extensionId: application.ownerId,
        applicationId: application.id,
        idempotencyKey: "slash-create",
        input: { argument: "do the work", fresh: false },
      }),
    ).resolves.toMatchObject({
      success: true,
      value: { receipt: { action: "list" }, instances: [] },
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: scope.sessionId,
        capability,
        input: {
          sessionId: scope.sessionId,
          argument: "do the work",
          fresh: false,
        },
      }),
    );
    await expect(controller.list(scope)).resolves.toMatchObject({
      ok: true,
      value: { instances: [] },
    });
  });
});

describe("authoritative runtime evidence", () => {
  it("lists completed evidence with no open instances and reopens through the published provider", async () => {
    const action = (id: string, capability: string) => ({
      id,
      version: "1.0.0",
      title: id,
      target: { kind: "capability" as const, capability },
      inputSchema: {},
      outputSchema: {},
      allowedScopes: ["session" as const],
      requiredPermissions: [],
      risk: "write" as const,
      idempotency: "supported" as const,
    });
    const application = {
      ...publishedApplication,
      application: {
        ...publishedApplication.application,
        actions: [
          action("marshal-evidence-list", "fixture.evidence.list"),
          action("marshal-evidence-open", "fixture.evidence.open"),
        ],
      },
    };
    const invoke = vi.fn<MarshalRuntimeApi["invoke"]>().mockResolvedValue({
      ok: true,
      receipts: [],
      value: {
        result: { output: {} },
        output: { entries: [{ id: "run-1", title: "Finished run", status: "completed" }] },
      },
    });
    const { handlers, dispose } = await createHarness({
      application,
      runtimeApi: testDouble<MarshalRuntimeApi>({ invoke }),
    });
    await expect(handlers.get("runtime-ui:getEvidence")!({}, scope)).resolves.toMatchObject({
      success: true,
      value: [{ ...scope, id: "run-1", status: "completed", extensionId: application.ownerId }],
    });
    await expect(
      handlers.get("runtime-ui:openEvidence")!(
        {},
        {
          ...scope,
          extensionId: application.ownerId,
          applicationId: application.id,
          id: "run-1",
          idempotencyKey: "open-1",
        },
      ),
    ).resolves.toMatchObject({ success: true });
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ...scope,
        capability: "fixture.evidence.open",
        input: { id: "run-1" },
      }),
    );
    dispose();
  });
  it("background evidence polling forbids approval prompts and silently skips gated capabilities", async () => {
    const action = (id: string, capability: string) => ({
      id,
      version: "1.0.0",
      title: id,
      target: { kind: "capability" as const, capability },
      inputSchema: {},
      outputSchema: {},
      allowedScopes: ["session" as const],
      requiredPermissions: [],
      risk: "write" as const,
      idempotency: "supported" as const,
    });
    const application = {
      ...publishedApplication,
      application: {
        ...publishedApplication.application,
        actions: [action("marshal-evidence-list", "fixture.evidence.list")],
      },
    };
    const invoke = vi.fn<MarshalRuntimeApi["invoke"]>().mockResolvedValue({
      ok: false,
      receipts: [],
      error: { code: "permission-denied", message: "Approval prompts are disabled." },
    });
    const { handlers, dispose } = await createHarness({
      application,
      runtimeApi: testDouble<MarshalRuntimeApi>({ invoke }),
    });
    // Repeated automatic refreshes: every call carries the forbid flag and the
    // gated capability produces zero entries with no error surfaced — nothing
    // for the approval UI to show.
    for (let refresh = 0; refresh < 3; refresh += 1) {
      // eslint-disable-next-line no-await-in-loop -- refreshes are sequential like the renderer's event/focus-driven polls
      await expect(handlers.get("runtime-ui:getEvidence")!({}, scope)).resolves.toMatchObject({
        success: true,
        value: [],
      });
    }
    expect(invoke).toHaveBeenCalledTimes(3);
    for (const [request] of invoke.mock.calls) {
      expect(request).toMatchObject({ approvalPolicy: "forbid" });
    }
    invoke.mockResolvedValueOnce({
      ok: false,
      receipts: [],
      error: { code: "operation-failed", message: "Extension crashed." },
    });
    await expect(handlers.get("runtime-ui:getEvidence")!({}, scope)).resolves.toMatchObject({
      success: false,
    });
    dispose();
  });

  it("rejects evidence opens for unpublished applications", async () => {
    const invoke = vi.fn<MarshalRuntimeApi["invoke"]>();
    const { handlers, dispose } = await createHarness({
      runtimeApi: testDouble<MarshalRuntimeApi>({ invoke }),
    });
    await expect(
      handlers.get("runtime-ui:openEvidence")!(
        {},
        {
          ...scope,
          extensionId: "unknown",
          applicationId: "unknown",
          id: "run",
          idempotencyKey: "open",
        },
      ),
    ).resolves.toMatchObject({ success: false });
    expect(invoke).not.toHaveBeenCalled();
    dispose();
  });
});
