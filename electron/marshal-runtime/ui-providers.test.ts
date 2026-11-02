import { mkdtemp, writeFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { createRuntimeServiceContainer, type InvocationContext } from "@marshal/runtime";
import {
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  type RuntimeExtensionUiApplication,
  type RuntimeExtensionUiPublicationService,
  type RuntimeExtensionUiPublishedApplication,
} from "@marshal/runtime/extensions";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeUiSurface, RuntimeUiOwner } from "../../common/runtime-ui";
import { testDouble } from "../testing/harness";
import { MarshalRuntimeUiController, type RuntimeUiDeliveryPorts } from "./ui-controller";
import { createRuntimeUiProvider } from "./ui-providers";

const extensionId = "extension.test";
const applicationId = "application.test";
const application: RuntimeExtensionUiApplication = {
  id: applicationId,
  title: "Test application",
  description: "Test application",
  renderId: "test-renderer",
  resource: { uri: "ui://test/application", mimeType: "text/html", text: "<main>Test</main>" },
  application: {
    version: "1.0.0",
    presentationModes: ["inline", "fullscreen", "pip"],
    actions: [],
    tools: [],
  },
};
const publishedApplication: RuntimeExtensionUiPublishedApplication = {
  ...application,
  ownerId: extensionId,
  revisionId: "activation-1",
};

function invocationContext(signal?: AbortSignal): InvocationContext {
  return {
    principal: { id: "test", kind: "agent" },
    identity: { harnessId: "test" },
    scope: { sessionId: "session-1" },
    metadata: { marshalWorkspaceName: "workspace-1" },
    ...(signal ? { signal } : {}),
  };
}

async function createHarness(
  resolveApplicationOwner?: (context: InvocationContext) => RuntimeUiOwner | undefined,
  listAuthoredApplications?: import("./ui-providers").ListAuthoredUiApplications,
) {
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
  const services = createRuntimeServiceContainer();
  const publication = testDouble<RuntimeExtensionUiPublicationService>({
    listApplications: vi
      .fn<RuntimeExtensionUiPublicationService["listApplications"]>()
      .mockResolvedValue([publishedApplication]),
  });
  await services.bind(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
    useValue: publication,
  });
  const provider = createRuntimeUiProvider(
    controller,
    services,
    resolveApplicationOwner,
    listAuthoredApplications,
  );
  const invoke = async (name: string, input: unknown, signal?: AbortSignal) => {
    const result = await provider.invoke(name, input, invocationContext(signal));
    return result.output;
  };
  const invokeWith = async (name: string, input: unknown, context: InvocationContext) => {
    const result = await provider.invoke(name, input, context);
    return result.output;
  };
  return {
    controller,
    delivery,
    invoke,
    invokeWith,
    provider,
    services,
    publication,
    deny() {
      denied = true;
    },
  };
}

describe("Runtime UI capability provider", () => {
  it("lists and pushes updates only to the authenticated persistent application owner", async () => {
    const owner: RuntimeUiOwner = {
      applicationScope: "user",
      workspaceName: "marshal",
      extensionId,
      applicationId,
    };
    const harness = await createHarness(() => owner);
    const content = {
      kind: "application" as const,
      renderId: application.renderId,
      resource: { uri: application.resource.uri, mimeType: "text/html" },
      descriptor: application.application,
    };
    const opened = await harness.controller.open({
      ...owner,
      surface: "tab",
      content,
      idempotencyKey: "owned-open",
    });
    if (!opened.ok || !opened.value.instance) throw new Error("Owned application did not open.");
    await harness.controller.open({
      ...owner,
      applicationId: "different-app",
      surface: "tab",
      content,
      idempotencyKey: "foreign-open",
    });
    const context = {
      ...invocationContext(),
      scope: { sessionId: "unrelated-runtime-tracing-session" },
      metadata: {
        marshalWorkspaceName: "forged-workspace",
        runtimeApplicationId: "different-app",
        runtimeApplicationScope: "workspace",
      },
    };
    const listed = await harness.provider.invoke("ui.application.list", {}, context);
    expect(listed.output).toMatchObject({
      ok: true,
      value: { instances: [{ instanceId: opened.value.instance.instanceId, owner }] },
    });
    const observed: string[] = [];
    const unsubscribe = harness.controller.subscribe((event) => {
      if (event.type === "instance-updated") observed.push(event.instance.instanceId);
    });
    const updated = await harness.provider.invoke(
      "ui.application.update",
      {
        extensionId,
        applicationId,
        instanceId: opened.value.instance.instanceId,
        state: { progress: "first streamed chunk" },
        idempotencyKey: "owned-update",
      },
      context,
    );
    expect(updated.output).toMatchObject({
      ok: true,
      value: { instance: { owner, content: { state: { progress: "first streamed chunk" } } } },
    });
    expect(observed).toEqual([opened.value.instance.instanceId]);
    unsubscribe();
  });

  it("denies foreign owner arguments and untrusted persistent metadata", async () => {
    const owner: RuntimeUiOwner = {
      applicationScope: "user",
      workspaceName: "marshal",
      extensionId,
      applicationId,
    };
    const harness = await createHarness(() => owner);
    await Promise.all(
      [
        { extensionId: "foreign", applicationId },
        { extensionId, applicationId: "foreign" },
        { extensionId, applicationId, sessionId: "other-session" },
      ].map((input) =>
        expect(
          harness.provider.invoke("ui.application.list", input, invocationContext()),
        ).rejects.toThrow("different owner or scope"),
      ),
    );
    await expect(
      harness.provider.invoke(
        "ui.document.open",
        { path: "/private/file", idempotencyKey: "foreign-path" },
        invocationContext(),
      ),
    ).rejects.toThrow("Select an execution session with a workspace");
    const untrusted = await createHarness();
    await expect(
      untrusted.provider.invoke(
        "ui.application.list",
        {},
        {
          principal: { id: "untrusted", kind: "agent" },
          metadata: {
            runtimeApplicationId: applicationId,
            runtimeExtensionIdentity: extensionId,
            runtimeApplicationScope: "user",
            marshalWorkspaceName: "marshal",
          },
        },
      ),
    ).rejects.toThrow("requires a session and workspace scope");
  });

  it("opens application evidence only inside its authenticated selected workspace", async () => {
    const root = await realpath(await mkdtemp(nodePath.join(tmpdir(), "app-document-")));
    const outside = await realpath(await mkdtemp(nodePath.join(tmpdir(), "app-outside-")));
    try {
      const source = nodePath.join(root, "source.ts");
      await writeFile(source, "export const value = 1;");
      await writeFile(nodePath.join(outside, "secret.ts"), "outside");
      await symlink(outside, nodePath.join(root, "escape"));
      const owner: RuntimeUiOwner = {
        applicationScope: "user",
        workspaceName: "marshal",
        extensionId,
        applicationId,
      };
      const h = await createHarness(() => owner);
      const context: InvocationContext = {
        ...invocationContext(),
        scope: { sessionId: "selected-session", workspacePath: root },
        metadata: { marshalWorkspaceName: "selected-workspace" },
      };
      const result = await h.invokeWith(
        "ui.document.open",
        { path: source, idempotencyKey: "owned-document" },
        context,
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          instance: {
            owner: { sessionId: "selected-session", workspaceName: "selected-workspace" },
            content: { kind: "file", path: source },
          },
        },
      });
      await Promise.all(
        [nodePath.join(outside, "secret.ts"), nodePath.join(root, "escape", "secret.ts")].map(
          (target) =>
            expect(
              h.invokeWith("ui.document.open", { path: target, idempotencyKey: "escape" }, context),
            ).rejects.toThrow("outside the selected workspace"),
        ),
      );
      await expect(
        h.invokeWith(
          "ui.document.open",
          { path: source, sessionId: "foreign", idempotencyKey: "foreign" },
          context,
        ),
      ).rejects.toThrow("cannot override");
      await expect(
        h.invokeWith(
          "ui.document.annotate",
          { path: source, instanceId: "foreign", idempotencyKey: "foreign" },
          context,
        ),
      ).rejects.toThrow("only its own application UI operations");
      h.deny();
      expect(
        await h.invokeWith("ui.document.open", { path: source, idempotencyKey: "denied" }, context),
      ).toMatchObject({ ok: false });
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("opens a document with session scope and respects UI authorization", async () => {
    const harness = await createHarness();
    const result = await harness.invoke("ui.document.open", {
      path: "/workspace/proposal.md",
      idempotencyKey: "document-1",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        instance: {
          surface: "panel",
          content: { kind: "file", path: "/workspace/proposal.md" },
          owner: { sessionId: "session-1", workspaceName: "workspace-1" },
        },
      },
    });
    harness.deny();
    expect(
      await harness.invoke("ui.document.open", {
        path: "/workspace/other.md",
        idempotencyKey: "document-2",
      }),
    ).toMatchObject({ ok: false, error: { code: "permission-denied" } });
  });

  it("opens a document with annotations and replaces them in place", async () => {
    const harness = await createHarness();
    const opened = await harness.invoke("ui.document.open", {
      path: "/workspace/src/agent.ts",
      revealLine: 40,
      annotations: [{ startLine: 40, endLine: 44, tone: "warning", label: "must read" }],
      idempotencyKey: "annotated-1",
    });
    expect(opened).toMatchObject({
      ok: true,
      value: {
        instance: {
          content: {
            kind: "file",
            revealLine: 40,
            annotations: [{ startLine: 40, endLine: 44, tone: "warning", label: "must read" }],
          },
        },
      },
    });
    if (!opened.ok || !opened.value.instance) throw new Error("document did not open");
    const instanceId = opened.value.instance.instanceId;
    const updated = await harness.invoke("ui.document.annotate", {
      instanceId,
      path: "/workspace/src/agent.ts",
      annotations: [{ startLine: 7, tone: "muted", label: "skip", detail: "logging only" }],
      idempotencyKey: "annotated-2",
    });
    expect(updated).toMatchObject({
      ok: true,
      value: {
        instance: {
          instanceId,
          content: { annotations: [{ startLine: 7, tone: "muted", label: "skip" }] },
        },
      },
    });
    expect(updated).not.toMatchObject({ value: { instance: { content: { revealLine: 40 } } } });
    expect(
      await harness.invoke("ui.document.annotate", {
        instanceId,
        path: "/workspace/src/other.ts",
        idempotencyKey: "annotated-3",
      }),
    ).toMatchObject({ ok: false, error: { code: "not-found" } });
    await expect(
      harness.invoke("ui.document.open", {
        path: "/workspace/src/agent.ts",
        annotations: [{ startLine: 9, endLine: 3, tone: "info", label: "backwards" }],
        idempotencyKey: "annotated-4",
      }),
    ).rejects.toThrow("must not precede");
  });

  it("registers only the exact closed Runtime UI capabilities", async () => {
    const { provider } = await createHarness();
    const descriptors = await provider.list(invocationContext());

    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      "ui.document.open",
      "ui.document.annotate",
      "ui.notification.show",
      "ui.chat.message.post",
      "ui.chat.card.show",
      "ui.application.open",
      "ui.application.update",
      "ui.application.focus",
      "ui.application.close",
      "ui.application.list",
    ]);
    for (const descriptor of descriptors) {
      expect(descriptor.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(descriptor.outputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["ok"],
      });
    }
  });

  function path(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
    let current = value;
    for (const key of keys) {
      if (typeof current !== "object" || current === null) return undefined;
      current = Object.fromEntries(Object.entries(current))[key];
    }
    return typeof current === "object" && current !== null
      ? Object.fromEntries(Object.entries(current))
      : undefined;
  }

  it("declares every field an opened instance actually carries", async () => {
    const { provider, invoke } = await createHarness();
    const opened = await invoke("ui.application.open", {
      extensionId,
      applicationId,
      surface: "panel",
      idempotencyKey: "open-schema-check",
    });
    const instance = path(opened, ["value", "instance"]);
    expect(instance).toBeDefined();
    const descriptor = (await provider.list(invocationContext())).find(
      (entry) => entry.name === "ui.application.open",
    );
    const declared = path(descriptor?.outputSchema, [
      "properties",
      "value",
      "properties",
      "instance",
      "properties",
    ]);
    expect(declared).toBeDefined();
    expect(Object.keys(instance ?? {}).filter((key) => !(key in (declared ?? {})))).toEqual([]);
  });

  it("opens all four surfaces and supports update, focus, list, close, and deduplication", async () => {
    const { invoke } = await createHarness();
    const surfaces: readonly RuntimeUiSurface[] = ["inline-card", "fullscreen", "tab", "panel"];
    const opened = await Promise.all(
      surfaces.map((surface) =>
        invoke("ui.application.open", {
          extensionId,
          applicationId,
          surface,
          state: { surface },
          idempotencyKey: `open-${surface}`,
        }),
      ),
    );
    expect(opened.map((result) => result.ok && result.value.instance?.surface)).toEqual(surfaces);

    const replay = await invoke("ui.application.open", {
      extensionId,
      applicationId,
      surface: "panel",
      state: { surface: "panel" },
      idempotencyKey: "open-panel",
    });
    expect(replay.ok && replay.value.receipt.status).toBe("deduplicated");

    const panel = opened[3];
    if (!panel.ok || !panel.value.instance) throw new Error("Panel did not open.");
    const instanceId = panel.value.instance.instanceId;
    await expect(
      invoke("ui.application.update", {
        extensionId,
        applicationId,
        instanceId,
        state: { updated: true },
        idempotencyKey: "update-panel",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { instance: { content: { state: { updated: true } } } },
    });
    await expect(
      invoke("ui.application.focus", {
        extensionId,
        applicationId,
        instanceId,
        idempotencyKey: "focus-panel",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      invoke("ui.application.list", { extensionId, applicationId }),
    ).resolves.toMatchObject({ ok: true, value: { instances: expect.any(Array) } });
    await expect(
      invoke("ui.application.close", {
        extensionId,
        applicationId,
        instanceId,
        idempotencyKey: "close-panel",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("delivers notifications, chat messages, and registered chat cards", async () => {
    const { delivery, invoke } = await createHarness();

    await expect(
      invoke("ui.notification.show", {
        extensionId,
        applicationId,
        title: "Title",
        message: "Body",
        idempotencyKey: "notification",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      invoke("ui.chat.message.post", {
        extensionId,
        applicationId,
        content: { kind: "markdown", markdown: "**Hello**" },
        idempotencyKey: "message",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      invoke("ui.chat.card.show", {
        extensionId,
        applicationId,
        state: { count: 1 },
        idempotencyKey: "card",
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(delivery.notification).toHaveBeenCalledOnce();
    expect(delivery.chatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: { kind: "markdown", markdown: "**Hello**" } }),
      undefined,
    );
    expect(delivery.chatCard).toHaveBeenCalledWith(
      expect.objectContaining({
        content: {
          kind: "application",
          renderId: application.renderId,
          resource: {
            uri: application.resource.uri,
            mimeType: application.resource.mimeType,
            name: application.title,
          },
          descriptor: application.application,
          state: { count: 1 },
        },
      }),
      undefined,
    );
  });

  it("returns typed denial and cancellation without delivery", async () => {
    const { delivery, deny, invoke } = await createHarness();
    deny();
    await expect(
      invoke("ui.notification.show", {
        extensionId,
        applicationId,
        title: "Title",
        message: "Body",
        idempotencyKey: "denied",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "permission-denied" } });
    expect(delivery.notification).not.toHaveBeenCalled();

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      invoke(
        "ui.chat.message.post",
        {
          extensionId,
          applicationId,
          content: { kind: "text", text: "Hello" },
          idempotencyKey: "aborted",
        },
        aborted.signal,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(delivery.chatMessage).not.toHaveBeenCalled();
  });

  it("uses the replacement publication service on the next application operation", async () => {
    const { invoke, services } = await createHarness();
    const replacement = {
      ...publishedApplication,
      revisionId: "activation-2",
      title: "Replacement application",
    };
    await services.replace(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
      useValue: testDouble<RuntimeExtensionUiPublicationService>({
        listApplications: vi
          .fn<RuntimeExtensionUiPublicationService["listApplications"]>()
          .mockResolvedValue([replacement]),
      }),
    });

    await expect(
      invoke("ui.application.open", {
        extensionId,
        applicationId,
        surface: "panel",
        idempotencyKey: "replacement-open",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        instance: {
          content: {
            resource: { name: "Replacement application" },
          },
        },
      },
    });
  });
});

describe("authored-render placement (reserved owner marshal.react-ui)", () => {
  const authoredRenderId = "a".repeat(64);
  const authoredApplication: RuntimeExtensionUiPublishedApplication = {
    ownerId: "marshal.react-ui",
    revisionId: authoredRenderId,
    id: authoredRenderId,
    title: "Authored status panel",
    description: "Compiled agent component",
    renderId: authoredRenderId,
    resource: {
      uri: "ui://marshal-react/runtime-renderer/1.0.0/index.html",
      mimeType: "text/html;profile=mcp-app",
    },
    application: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
  };

  it("opens, focuses, and closes an authored render via the projection with the caller's exact context", async () => {
    const seenContexts: InvocationContext[] = [];
    const listAuthored = vi.fn<import("./ui-providers").ListAuthoredUiApplications>(
      async (context) => {
        seenContexts.push(context);
        return [authoredApplication];
      },
    );
    const { invokeWith } = await createHarness(undefined, listAuthored);
    const context = invocationContext();
    const opened = await invokeWith(
      "ui.application.open",
      {
        extensionId: "marshal.react-ui",
        applicationId: authoredRenderId,
        surface: "inline-card",
        state: { greeting: "hello" },
        idempotencyKey: "authored-open-1",
      },
      context,
    );
    if (!opened.ok || !opened.value.instance) throw new Error("open failed");
    expect(opened.value.instance.content).toMatchObject({
      kind: "application",
      renderId: authoredRenderId,
      resource: { uri: authoredApplication.resource.uri, mimeType: "text/html;profile=mcp-app" },
      descriptor: authoredApplication.application,
      state: { greeting: "hello" },
    });
    expect(seenContexts[0]).toBe(context);

    const instanceId = opened.value.instance.instanceId;
    await invokeWith(
      "ui.application.focus",
      {
        extensionId: "marshal.react-ui",
        applicationId: authoredRenderId,
        instanceId,
        idempotencyKey: "authored-focus-1",
      },
      context,
    );
    await invokeWith(
      "ui.application.close",
      {
        extensionId: "marshal.react-ui",
        applicationId: authoredRenderId,
        instanceId,
        idempotencyKey: "authored-close-1",
      },
      context,
    );
    expect(listAuthored).toHaveBeenCalledTimes(3);
  });

  it("shows an authored render as a chat card", async () => {
    const { invoke, delivery } = await createHarness(undefined, async () => [authoredApplication]);
    await invoke("ui.chat.card.show", {
      extensionId: "marshal.react-ui",
      applicationId: authoredRenderId,
      idempotencyKey: "authored-card-1",
    });
    expect(delivery.chatCard).toHaveBeenCalledTimes(1);
  });

  it("never resolves the reserved owner from extension publications (shadow prevention)", async () => {
    const shadow: RuntimeExtensionUiPublishedApplication = {
      ...authoredApplication,
      title: "Shadowing extension publication",
    };
    const { invoke, publication } = await createHarness(undefined, async () => []);
    vi.mocked(publication.listApplications).mockResolvedValue([publishedApplication, shadow]);
    await expect(
      invoke("ui.application.open", {
        extensionId: "marshal.react-ui",
        applicationId: authoredRenderId,
        surface: "panel",
        idempotencyKey: "authored-shadow-1",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(publication.listApplications).not.toHaveBeenCalled();
  });

  it("keeps non-reserved resolution on the publication service and out of the projection", async () => {
    const listAuthored = vi.fn<import("./ui-providers").ListAuthoredUiApplications>(async () => [
      authoredApplication,
    ]);
    const { invoke } = await createHarness(undefined, listAuthored);
    const opened = await invoke("ui.application.open", {
      extensionId,
      applicationId,
      surface: "panel",
      idempotencyKey: "extension-open-1",
    });
    if (!opened.ok || !opened.value.instance) throw new Error("open failed");
    expect(opened.value.instance.content).toMatchObject({ renderId: "test-renderer" });
    expect(listAuthored).not.toHaveBeenCalled();
  });

  it("fails closed with runtime-unavailable when the projection bridge is not wired", async () => {
    const { invoke } = await createHarness();
    await expect(
      invoke("ui.application.open", {
        extensionId: "marshal.react-ui",
        applicationId: authoredRenderId,
        surface: "tab",
        idempotencyKey: "authored-unwired-1",
      }),
    ).rejects.toMatchObject({ code: "runtime-unavailable" });
  });

  it("scopes resolution to the requested render id only", async () => {
    const other: RuntimeExtensionUiPublishedApplication = {
      ...authoredApplication,
      id: "b".repeat(64),
      renderId: "b".repeat(64),
      revisionId: "b".repeat(64),
    };
    const { invoke } = await createHarness(undefined, async () => [other]);
    await expect(
      invoke("ui.application.open", {
        extensionId: "marshal.react-ui",
        applicationId: authoredRenderId,
        surface: "panel",
        idempotencyKey: "authored-miss-1",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
