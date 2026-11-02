import { createRuntimeServiceContainer } from "@marshal/runtime";
import {
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  type RuntimeExtensionUiPublicationService,
  type RuntimeExtensionUiPublishedApplication,
} from "@marshal/runtime/extensions";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import { MarshalRuntimeUiController } from "../marshal-runtime";
import type { MarshalRuntimeApi } from "../marshal-runtime/contracts";
import { testDouble } from "../testing/harness";
import { registerRuntimeUiHandlers } from "./runtime-ui-ipc";
import {
  readAuthoredRenderViewports,
  sealAuthoredUiResource,
} from "./runtime-ui-packaged-resource";

const application: RuntimeExtensionUiPublishedApplication = {
  id: "sample",
  ownerId: "@example/new-extension",
  revisionId: "r1",
  title: "Sample",
  description: "Custom packaged UI",
  renderId: "unknown-to-host",
  resource: { uri: "ui://example/sample", mimeType: "text/html", text: "<main>Version one</main>" },
  application: {
    version: "1.0.0",
    presentationModes: ["inline"],
    actions: [],
    tools: [{ id: "echo", name: "example.echo", inputSchema: { type: "object" } }],
  },
};

async function harness() {
  let applications = [application];
  const services = createRuntimeServiceContainer();
  await services.bind(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
    useValue: testDouble<RuntimeExtensionUiPublicationService>({
      listApplications: async () => applications,
    }),
  });
  const controller = new MarshalRuntimeUiController(
    () => Date.now(),
    (request) => ({ allowed: true, scope: request.scope }),
    {
      notification: async () => undefined,
      chatMessage: async () => undefined,
      chatCard: async () => undefined,
    },
  );
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const invoke = vi.fn<MarshalRuntimeApi["invoke"]>().mockResolvedValue({
    ok: true,
    receipts: [],
    value: { output: "echoed", result: { output: "echoed" } },
  });
  const resourceReader =
    vi.fn<NonNullable<Parameters<typeof registerRuntimeUiHandlers>[0]["readResource"]>>();
  const dispose = registerRuntimeUiHandlers({
    controller,
    serviceContainer: services,
    runtimeApi: testDouble<MarshalRuntimeApi>({ invoke }),
    readResource: resourceReader,
    ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) =>
      handlers.set(channel, testDouble<(...args: unknown[]) => unknown>(handler)),
  });
  const owner = {
    sessionId: "session",
    workspaceName: "workspace",
    extensionId: application.ownerId,
    applicationId: application.id,
  };
  const opened = await controller.open({
    ...owner,
    surface: "tab",
    content: {
      kind: "application",
      renderId: application.renderId,
      descriptor: application.application,
      resource: { uri: application.resource.uri, mimeType: application.resource.mimeType! },
    },
    idempotencyKey: "open",
  });
  if (!opened.ok || !opened.value.instance)
    throw new Error(`Application did not open: ${JSON.stringify(opened)}`);
  const request = {
    ...owner,
    instanceId: opened.value.instance.instanceId,
    publicationRevisionId: "r1",
  };
  const sender = testDouble<WebContents>({
    id: 1,
    once: vi.fn<WebContents["once"]>(),
    removeListener: vi.fn<WebContents["removeListener"]>(),
  });
  return {
    request,
    invoke,
    resourceReader,
    controller,
    dispose,
    replace: (next: RuntimeExtensionUiPublishedApplication[]) => {
      applications = next;
    },
    call: (channel: string, input: unknown, senderOverride = sender) =>
      handlers.get(channel)!({ sender: senderOverride }, input),
  };
}

describe("packaged Runtime UI authority", () => {
  it("rejects old executable revisions and accepts a new action after publication refresh", async () => {
    const h = await harness();
    const next = {
      ...application,
      revisionId: "r2",
      application: {
        ...application.application,
        tools: [{ id: "new", name: "example.new", inputSchema: {} }],
      },
    };
    h.replace([next]);
    expect(
      h.controller.refreshApplication(h.request, {
        kind: "application",
        renderId: next.renderId,
        resource: { uri: next.resource.uri, mimeType: "text/html" },
        descriptor: next.application,
      }).ok,
    ).toBe(true);
    expect(
      await h.call("runtime-ui:invokeCapability", {
        ...h.request,
        capability: "example.new",
        input: {},
        idempotencyKey: "old-script",
      }),
    ).toMatchObject({ success: false });
    expect(
      await h.call("runtime-ui:invokeCapability", {
        ...h.request,
        publicationRevisionId: "r2",
        capability: "example.new",
        input: {},
        idempotencyKey: "new-script",
      }),
    ).toMatchObject({ success: true });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it.each(["approval-required", "aborted"] as const)("preserves the %s outcome", async (code) => {
    const h = await harness();
    h.invoke.mockResolvedValueOnce({
      ok: false,
      receipts: [],
      error: { code, message: `Outcome: ${code}` },
    });
    expect(
      await h.call("runtime-ui:invokeCapability", {
        ...h.request,
        capability: "example.echo",
        input: {},
        idempotencyKey: code,
      }),
    ).toMatchObject({ success: false, error: { code, message: `Outcome: ${code}` } });
    h.dispose();
  });

  it("loads owned publication bytes and observes replacement without a static renderer policy", async () => {
    const h = await harness();
    const request = { ...h.request, uri: application.resource.uri };
    const first = await h.call("runtime-ui:readResource", request);
    expect(first).toMatchObject({
      success: true,
      value: {
        text: application.resource.text,
        revisionId: "r1",
        integrity: expect.stringMatching(/^sha256-/),
      },
    });
    h.replace([
      {
        ...application,
        revisionId: "r2",
        resource: { ...application.resource, text: "<main>Version two</main>" },
      },
    ]);
    const second = await h.call("runtime-ui:readResource", request);
    expect(second).toMatchObject({
      success: true,
      value: { text: "<main>Version two</main>", revisionId: "r2" },
    });
    expect(second).not.toEqual(first);
    expect(h.resourceReader).not.toHaveBeenCalled();
    h.dispose();
  });

  it("denies foreign resources, undeclared capabilities, forged owners, and revoked publications", async () => {
    const h = await harness();
    expect(
      await h.call("runtime-ui:readResource", { ...h.request, uri: "file:///private/token" }),
    ).toMatchObject({ success: false, error: { code: "permission-denied" } });
    expect(
      await h.call("runtime-ui:readResource", {
        ...h.request,
        extensionId: "@other/extension",
        uri: application.resource.uri,
      }),
    ).toMatchObject({ success: false });
    expect(
      await h.call("runtime-ui:invokeCapability", {
        ...h.request,
        capability: "private.admin",
        input: {},
        idempotencyKey: "denied",
      }),
    ).toMatchObject({ success: false });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(
      await h.call("runtime-ui:invokeCapability", {
        ...h.request,
        capability: "example.echo",
        input: {},
        idempotencyKey: "allowed",
      }),
    ).toMatchObject({ success: true, value: { output: "echoed" } });
    h.replace([]);
    expect(
      await h.call("runtime-ui:readResource", { ...h.request, uri: application.resource.uri }),
    ).toMatchObject({ success: false });
    expect(
      await h.call("runtime-ui:invokeCapability", {
        ...h.request,
        capability: "example.echo",
        input: {},
        idempotencyKey: "revoked",
      }),
    ).toMatchObject({ success: false });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it("uses current publication authority when an old frame declares a removed action", async () => {
    const h = await harness();
    h.replace([
      { ...application, revisionId: "r2", application: { ...application.application, tools: [] } },
    ]);
    expect(
      await h.call("runtime-ui:invokeCapability", {
        ...h.request,
        capability: "example.echo",
        input: {},
        idempotencyKey: "removed",
      }),
    ).toMatchObject({ success: false });
    expect(h.invoke).not.toHaveBeenCalled();
    h.dispose();
  });

  it("keeps a chatty card's bridge calls off the session ui.* command budget", async () => {
    const h = await harness();
    for (let index = 0; index < 200; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- polling cards call sequentially
      const result = await h.call("runtime-ui:invokeCapability", {
        ...h.request,
        capability: "example.echo",
        input: {},
        idempotencyKey: `poll-${index}`,
      });
      expect(result).toMatchObject({ success: true });
    }
    expect(
      await h.controller.list({ sessionId: "session", workspaceName: "workspace" }),
    ).toMatchObject({ ok: true });
    expect(h.invoke).toHaveBeenCalledTimes(200);
    h.dispose();
  });

  it("cancels only a matching sender's pending invocation and propagates abort", async () => {
    const h = await harness();
    let signal: AbortSignal | undefined;
    h.invoke.mockImplementation(async (request) => {
      signal = request.signal;
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      return {
        ok: false,
        receipts: [],
        error: {
          code: "operation-failed",
          message: "Cancelled; reconcile any accepted external write before retry.",
        },
      };
    });
    const operation = h.call("runtime-ui:invokeCapability", {
      ...h.request,
      capability: "example.echo",
      input: {},
      idempotencyKey: "pending",
    });
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalled());
    expect(
      await h.call(
        "runtime-ui:cancelCapability",
        { ...h.request, idempotencyKey: "pending" },
        testDouble<WebContents>({ id: 2 }),
      ),
    ).toMatchObject({ success: true, value: { cancelled: false } });
    expect(signal?.aborted).toBe(false);
    expect(
      await h.call("runtime-ui:cancelCapability", { ...h.request, idempotencyKey: "pending" }),
    ).toMatchObject({ success: true, value: { cancelled: true } });
    expect(signal?.aborted).toBe(true);
    expect(await operation).toMatchObject({ success: false });
    h.dispose();
  });
});

describe("sealAuthoredUiResource", () => {
  it("pins the trusted instance revision and computes integrity for port-resolved templates", () => {
    const sealed = sealAuthoredUiResource(
      {
        uri: "ui://marshal-react/runtime-renderer/1/index.html",
        mimeType: "text/html",
        text: "<main>t</main>",
      },
      "render-revision",
    );
    expect(sealed.revisionId).toBe("render-revision");
    expect(sealed.integrity).toMatch(/^sha256-/);
    expect(sealed.mimeType).toBe("text/html");
    expect(sealed.text).toBe("<main>t</main>");
  });

  it("rejects missing and oversized template text", () => {
    expect(() => sealAuthoredUiResource({ uri: "ui://x", mimeType: "text/html" }, "r")).toThrow(
      /8 MiB/,
    );
    expect(() =>
      sealAuthoredUiResource(
        { uri: "ui://x", mimeType: "text/html", text: "a".repeat(8 * 1024 * 1024 + 1) },
        "r",
      ),
    ).toThrow(/8 MiB/);
  });
});

describe("readAuthoredRenderViewports", () => {
  const scope = { sessionId: "session-1", workspaceName: "marshal" };
  function api(invoke: MarshalRuntimeApi["invoke"]): MarshalRuntimeApi {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only invoke is exercised
    return { invoke } as MarshalRuntimeApi;
  }

  it("projects the render's declared viewports onto the sealed resource", async () => {
    const invoke = vi.fn<MarshalRuntimeApi["invoke"]>(async () => ({
      ok: true,
      value: {
        output: { render: { id: "r1", props: { marshalViewports: ["mobile"] } } },
        result: { output: null },
      },
      receipts: [],
    }));
    const viewports = await readAuthoredRenderViewports(api(invoke), scope, "r1");
    expect(viewports).toEqual(["mobile"]);
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      capability: "ui.renders.get",
      input: { renderId: "r1" },
      approvalPolicy: "forbid",
    });
    const sealed = sealAuthoredUiResource(
      { uri: "ui://x", mimeType: "text/html", text: "<main/>" },
      "r1",
      viewports,
    );
    expect(sealed.viewports).toEqual(["mobile"]);
  });

  it("keeps the desktop-only default when the render cannot be read", async () => {
    const invoke = vi.fn<MarshalRuntimeApi["invoke"]>(async () => {
      throw new Error("denied");
    });
    expect(await readAuthoredRenderViewports(api(invoke), scope, "r1")).toBeUndefined();
    expect(await readAuthoredRenderViewports(undefined, scope, "r1")).toBeUndefined();
  });
});
