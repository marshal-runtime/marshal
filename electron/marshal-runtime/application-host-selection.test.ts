import {
  createRuntimeServiceContainer,
  type InvocationContext,
  type RuntimeCallContext,
} from "@marshal/runtime";
import type { PermissionCheck } from "@marshal/runtime/core";
import {
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  type RuntimeExtensionUiPublicationService,
  type RuntimeExtensionUiPublishedApplication,
} from "@marshal/runtime/extensions";
import { describe, expect, it, vi } from "vitest";

import {
  RUNTIME_UI_USER_SCOPE,
  type RuntimeUiInstance,
  type RuntimeUiApplicationContent,
} from "../../common/runtime-ui";
import { testDouble } from "../testing/harness";
import { RuntimeApplicationAuthority } from "./application-authority";
import { RuntimeApplicationHost } from "./application-host";
import type { ApplicationJobInvocation } from "./application-jobs";
import type { MarshalRuntimeApi } from "./contracts";
import type { MarshalRuntimeHost } from "./host";
import type { SelectedSessionDeliveryService } from "./selected-session-delivery";

describe("application session selection and publication identity", () => {
  it("creates a trusted grant for the originating session and rejects rebinding", async () => {
    const services = createRuntimeServiceContainer();
    await services.bind(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
      useValue: testDouble<RuntimeExtensionUiPublicationService>({
        listApplications: async () => [
          testDouble<RuntimeExtensionUiPublishedApplication>({
            ownerId: "fixture",
            id: "app",
          }),
        ],
      }),
    });
    const grant = vi.fn<SelectedSessionDeliveryService["grant"]>(async (_owner, targetSessionId) =>
      testDouble({ grantId: "owner-grant", targetSessionId }),
    );
    const resolveGrant = vi.fn<SelectedSessionDeliveryService["resolveGrant"]>(async () => ({
      sessionId: "origin-session",
      workspaceName: "origin-workspace",
      runtimeId: "runtime",
    }));
    const revokeGrant = vi.fn<SelectedSessionDeliveryService["revokeGrant"]>(async () => undefined);
    const host = new RuntimeApplicationHost({
      services,
      authority: new RuntimeApplicationAuthority(),
      runtime: testDouble<MarshalRuntimeHost>({}),
      api: testDouble<MarshalRuntimeApi>({}),
      delivery: testDouble<SelectedSessionDeliveryService>({ grant, resolveGrant, revokeGrant }),
      resolveWorkspace: async () => "/workspace",
    });
    const instance = testDouble<RuntimeUiInstance>({
      instanceId: "owner-instance",
      owner: {
        sessionId: "origin-session",
        workspaceName: "origin-workspace",
        extensionId: "fixture",
        applicationId: "app",
      },
    });

    const concurrent = await Promise.all([
      host.getSelectedSession(instance),
      host.getSelectedSession(instance),
      host.selectSession(instance, "origin-session"),
    ]);
    expect(concurrent[0]).toMatchObject({
      grantId: "owner-grant",
      sessionId: "origin-session",
      workspaceName: "origin-workspace",
    });
    expect(concurrent[1]).toEqual(concurrent[0]);
    expect(concurrent[2]).toEqual(concurrent[0]);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(grant).toHaveBeenCalledWith(instance.owner, "origin-session");
    resolveGrant.mockResolvedValue({
      sessionId: "other-session",
      workspaceName: "other-workspace",
      runtimeId: "runtime",
    });
    await expect(host.getSelectedSession(instance)).rejects.toThrow("originating session");
    expect(revokeGrant).toHaveBeenCalledWith(instance.owner, "owner-grant");
    await expect(host.selectSession(instance, "other-session")).rejects.toThrow(
      "bound to its originating session",
    );
  });

  it("revokes the earlier grant when concurrent selections arrive for the same application", async () => {
    const services = createRuntimeServiceContainer();
    await services.bind(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
      useValue: testDouble<RuntimeExtensionUiPublicationService>({
        listApplications: vi.fn<RuntimeExtensionUiPublicationService["listApplications"]>(
          async () => [testDouble({ ownerId: "fixture", id: "app" })],
        ),
      }),
    });
    const active = new Set<string>();
    const grant = vi.fn<SelectedSessionDeliveryService["grant"]>(
      async (_owner, targetSessionId) => {
        active.add(targetSessionId);
        return testDouble({ grantId: targetSessionId, targetSessionId });
      },
    );
    const revokeGrant = vi.fn<SelectedSessionDeliveryService["revokeGrant"]>(
      async (_owner, grantId) => {
        active.delete(grantId);
      },
    );
    const resolveGrant = vi.fn<SelectedSessionDeliveryService["resolveGrant"]>(
      async (_owner, grantId) => ({
        sessionId: grantId,
        workspaceName: "selected-workspace",
        runtimeId: "test-runtime",
      }),
    );
    const host = new RuntimeApplicationHost({
      services,
      authority: new RuntimeApplicationAuthority(),
      runtime: testDouble<MarshalRuntimeHost>({}),
      api: testDouble<MarshalRuntimeApi>({}),
      delivery: testDouble<SelectedSessionDeliveryService>({
        grant,
        revokeGrant,
        resolveGrant,
      }),
      resolveWorkspace: async () => "/workspace",
    });
    const instance = testDouble<RuntimeUiInstance>({
      instanceId: "app-instance",
      owner: { ...RUNTIME_UI_USER_SCOPE, extensionId: "fixture", applicationId: "app" },
    });
    const selections = await Promise.all([
      host.selectSession(instance, "first"),
      host.selectSession(instance, "second"),
      host.selectSession(instance, "third"),
    ]);
    expect([...active]).toEqual(["third"]);
    expect(selections.at(-1)).toMatchObject({
      sessionId: "third",
      workspaceName: "selected-workspace",
    });
    expect(revokeGrant).toHaveBeenCalledTimes(2);
    await host.selectSession(instance);
    expect(active.size).toBe(0);
    resolveGrant.mockRejectedValueOnce(new Error("stale grant"));
    await expect(host.selectSession(instance, "failed")).rejects.toThrow("stale grant");
    expect(active.size).toBe(0);
    expect(revokeGrant).toHaveBeenCalledWith(instance.owner, "failed");
  });
  it("does not replay an approval after the application publication changes", async () => {
    const services = createRuntimeServiceContainer();
    let publication: RuntimeExtensionUiPublishedApplication = {
      ownerId: "fixture",
      id: "app",
      revisionId: "v1",
      title: "App",
      description: "App",
      renderId: "fixture.app",
      resource: { uri: "ui://fixture/app", mimeType: "text/html", text: "<main>v1</main>" },
      application: {
        version: "1.0.0",
        presentationModes: ["inline"],
        actions: [],
        tools: [{ id: "write", name: "fixture.write", inputSchema: { type: "object" } }],
      },
    };
    await services.bind(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
      useValue: testDouble<RuntimeExtensionUiPublicationService>({
        listApplications: vi.fn<RuntimeExtensionUiPublicationService["listApplications"]>(
          async () => [publication],
        ),
      }),
    });
    const executeApplication = vi.fn<MarshalRuntimeHost["executeApplication"]>().mockResolvedValue(
      testDouble({
        status: "approval_required",
        approval: { approvalId: "approval-v1" },
        error: { message: "Approval needed" },
        receipt: { requestId: "request" },
      }),
    );
    const approvalStatus = vi.fn<MarshalRuntimeHost["approvalStatus"]>().mockReturnValue("pending");
    const host = new RuntimeApplicationHost({
      services,
      authority: new RuntimeApplicationAuthority(),
      runtime: testDouble<MarshalRuntimeHost>({ executeApplication, approvalStatus }),
      api: testDouble<MarshalRuntimeApi>({}),
      delivery: testDouble<SelectedSessionDeliveryService>({}),
      resolveWorkspace: async () => "/workspace",
    });
    const content: RuntimeUiApplicationContent = {
      kind: "application",
      renderId: publication.renderId,
      resource: { uri: publication.resource.uri, mimeType: "text/html" },
      descriptor: publication.application,
    };
    const instance = testDouble<RuntimeUiInstance & { content: RuntimeUiApplicationContent }>({
      instanceId: "app-instance",
      owner: { ...RUNTIME_UI_USER_SCOPE, extensionId: "fixture", applicationId: "app" },
      content,
    });
    const request = {
      ...instance.owner,
      instanceId: instance.instanceId,
      capability: "fixture.write",
      input: {},
      idempotencyKey: "same-request",
    };
    expect(await host.invoke(instance, request, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: "approval-required" },
    });
    approvalStatus.mockReturnValue("approved");
    publication = { ...publication, revisionId: "v2" };
    expect(await host.invoke(instance, request, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: "idempotency-conflict" },
    });
    expect(executeApplication).toHaveBeenCalledTimes(1);
  });
});

async function jobHarness() {
  const owner = { ...RUNTIME_UI_USER_SCOPE, extensionId: "fixture", applicationId: "app" };
  let publication: RuntimeExtensionUiPublishedApplication | null = {
    ownerId: owner.extensionId,
    id: owner.applicationId,
    revisionId: "v1",
    title: "Fixture",
    description: "Fixture",
    renderId: "fixture.app",
    resource: { uri: "ui://fixture/app", mimeType: "text/html" },
    application: {
      version: "1.0.0",
      presentationModes: ["inline"],
      actions: [],
      tools: ["fixture.wake", "fixture.unarmed", "marshal.session.delivery.send"].map((name) => ({
        id: name,
        name,
        inputSchema: { type: "object" },
      })),
    },
  };
  const services = createRuntimeServiceContainer();
  await services.bind(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
    useValue: testDouble<RuntimeExtensionUiPublicationService>({
      listApplications: async () => (publication ? [publication] : []),
    }),
  });
  const authority = new RuntimeApplicationAuthority();
  const resolveScope = vi.fn<MarshalRuntimeHost["resolveScope"]>(async (scope) => ({
    ...scope,
    workspacePath: "/coordinator-workspace",
  }));
  const ownsExtensionCapability = vi.fn<MarshalRuntimeHost["ownsExtensionCapability"]>(
    async () => true,
  );
  const executeApplication = vi.fn<MarshalRuntimeHost["executeApplication"]>();
  const resolveGrant = vi.fn<SelectedSessionDeliveryService["resolveGrant"]>();
  const resolveWorkspace = vi.fn<(scope: typeof RUNTIME_UI_USER_SCOPE) => Promise<string | null>>(
    async () => "/user-workspace",
  );
  const host = new RuntimeApplicationHost({
    services,
    authority,
    runtime: testDouble<MarshalRuntimeHost>({
      resolveScope,
      ownsExtensionCapability,
      executeApplication,
    }),
    api: testDouble<MarshalRuntimeApi>({}),
    delivery: testDouble<SelectedSessionDeliveryService>({ resolveGrant }),
    resolveWorkspace,
  });
  let active = true;
  const job: ApplicationJobInvocation = {
    invocationId: "invocation-1",
    jobId: "job-1",
    owner,
    capabilities: new Set(["fixture.wake", "fixture.unpublished", "marshal.session.delivery.send"]),
    executionScope: { sessionId: "automation-coordinator", workspaceName: "repo" },
    isActive: async () => active,
  };
  const caller: InvocationContext = {
    principal: { id: "native-step", kind: "agent" },
    scope: { sessionId: "caller-session" },
  };
  return {
    host,
    authority,
    owner,
    job,
    caller,
    resolveScope,
    ownsExtensionCapability,
    executeApplication,
    resolveGrant,
    resolveWorkspace,
    setActive(value: boolean) {
      active = value;
    },
    replacePublication(revisionId: string) {
      if (publication) publication = { ...publication, revisionId };
    },
    removePublication() {
      publication = null;
    },
  };
}

function nestedCheck(context: RuntimeCallContext, name: string): PermissionCheck {
  return testDouble<PermissionCheck>({
    context,
    capability: { name },
    requirements: [],
    request: { input: {} },
  });
}

const jobSuccess = (output: unknown) =>
  testDouble<Awaited<ReturnType<MarshalRuntimeHost["executeApplication"]>>>({
    status: "success",
    result: { output },
    receipt: { requestId: "fixture" },
  });

describe("background application invocation authority", () => {
  it("requires both a current application declaration and exact extension capability ownership", async () => {
    const h = await jobHarness();
    expect(await h.host.isCapabilityOwned(h.owner, "fixture.unpublished")).toBe(false);
    expect(h.ownsExtensionCapability).not.toHaveBeenCalled();
    h.ownsExtensionCapability.mockResolvedValueOnce(false);
    expect(await h.host.isCapabilityOwned(h.owner, "fixture.wake")).toBe(false);
    expect(await h.host.isCapabilityOwned(h.owner, "fixture.wake")).toBe(true);
    expect(h.ownsExtensionCapability).toHaveBeenLastCalledWith("fixture", "fixture.wake");
    h.removePublication();
    expect(await h.host.isCapabilityOwned(h.owner, "fixture.wake")).toBe(false);
    expect(h.ownsExtensionCapability).toHaveBeenCalledTimes(2);
  });

  it("mints fresh bounded authority for the explicit coordinator without selecting a chat", async () => {
    const h = await jobHarness();
    const contexts: RuntimeCallContext[] = [];
    h.executeApplication.mockImplementation(async (_request, context) => {
      contexts.push(context);
      const scoped = h.authority.resolve(context);
      expect(scoped).toMatchObject({
        owner: h.owner,
        backgroundJobInvocationId: h.job.invocationId,
        executionScope: h.job.executionScope,
        workspacePath: "/coordinator-workspace",
      });
      expect(scoped?.owner).not.toHaveProperty("sessionId");
      expect(context.sessionId).toBe("automation-coordinator");
      expect((await h.authority.decide(nestedCheck(context, "fixture.wake")))?.decision).toBe(
        "allow",
      );
      expect(
        (await h.authority.decide(nestedCheck(context, "fixture.unpublished")))?.decision,
      ).toBe("deny");
      expect((await h.authority.decide(nestedCheck(context, "fixture.unarmed")))?.decision).toBe(
        "deny",
      );
      return jobSuccess("finished");
    });
    await expect(h.host.invokeJob(h.job, "fixture.unpublished", {}, h.caller)).rejects.toThrow(
      "not published",
    );
    await expect(h.host.invokeJob(h.job, "fixture.unarmed", {}, h.caller)).rejects.toThrow(
      "not published",
    );
    expect(h.executeApplication).not.toHaveBeenCalled();
    await expect(h.host.invokeJob(h.job, "fixture.wake", {}, h.caller)).resolves.toBe("finished");
    await expect(h.host.invokeJob(h.job, "fixture.wake", {}, h.caller)).resolves.toBe("finished");
    expect(contexts[0].metadata?.marshalApplicationInvocation).not.toBe(
      contexts[1].metadata?.marshalApplicationInvocation,
    );
    expect(h.authority.resolve(contexts[0])).toBeUndefined();
    expect(h.authority.resolve(contexts[1])).toBeUndefined();
    expect(h.resolveScope).toHaveBeenCalledWith(h.job.executionScope, undefined);
    expect(h.resolveGrant).not.toHaveBeenCalled();
    expect(h.resolveWorkspace).not.toHaveBeenCalled();
  });

  it.each(["publication replacement", "caller cancellation"] as const)(
    "fences nested operations after %s",
    async (change) => {
      const h = await jobHarness();
      const controller = new AbortController();
      let recordedContext: RuntimeCallContext | undefined;
      h.executeApplication.mockImplementation(async (_request, context) => {
        recordedContext = context;
        expect(context.signal).toBe(controller.signal);
        const scoped = h.authority.resolve(context);
        expect(await scoped?.isActive()).toBe(true);
        if (change === "publication replacement") h.replacePublication("v2");
        else controller.abort();
        expect(await scoped?.isActive()).toBe(false);
        expect((await h.authority.decide(nestedCheck(context, "fixture.wake")))?.decision).toBe(
          "deny",
        );
        return jobSuccess("callback settled");
      });
      await h.host.invokeJob(h.job, "fixture.wake", {}, { ...h.caller, signal: controller.signal });
      expect(recordedContext).toBeDefined();
      expect(h.authority.resolve(recordedContext!)).toBeUndefined();
    },
  );

  it("allows the active callback to report its own disarm while revoking further operations", async () => {
    const h = await jobHarness();
    let recordedContext: RuntimeCallContext | undefined;
    h.executeApplication.mockImplementation(async (_request, context) => {
      recordedContext = context;
      expect(await h.authority.resolve(context)?.isActive()).toBe(true);
      h.setActive(false);
      expect(await h.authority.resolve(context)?.isActive()).toBe(false);
      return jobSuccess({ state: "disarmed" });
    });
    await expect(h.host.invokeJob(h.job, "fixture.wake", {}, h.caller)).resolves.toEqual({
      state: "disarmed",
    });
    expect(h.authority.resolve(recordedContext!)).toBeUndefined();
    await expect(h.host.invokeJob(h.job, "fixture.wake", {}, h.caller)).rejects.toThrow("inactive");
    expect(h.executeApplication).toHaveBeenCalledOnce();
  });
  it.each(["persistent", "session"] as const)(
    "%s UI invocation carries its trusted grant and resolved execution worktree",
    async (ownership) => {
      const services = createRuntimeServiceContainer();
      const publication: RuntimeExtensionUiPublishedApplication = {
        ownerId: "fixture",
        id: "app",
        revisionId: "v1",
        title: "App",
        description: "App",
        renderId: "fixture.app",
        resource: { uri: "ui://fixture/app", mimeType: "text/html", text: "<main>v1</main>" },
        application: {
          version: "1.0.0",
          presentationModes: ["inline"],
          actions: [],
          tools: [{ id: "ask", name: "fixture.ask", inputSchema: { type: "object" } }],
        },
      };
      await services.bind(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
        useValue: testDouble<RuntimeExtensionUiPublicationService>({
          listApplications: vi.fn<RuntimeExtensionUiPublicationService["listApplications"]>(
            async () => [publication],
          ),
        }),
      });
      const executeApplication = vi
        .fn<MarshalRuntimeHost["executeApplication"]>()
        .mockResolvedValue(
          testDouble({
            status: "success",
            result: { output: { delivered: true } },
            receipt: { requestId: "w2f2-probe" },
          }),
        );
      const host = new RuntimeApplicationHost({
        services,
        authority: new RuntimeApplicationAuthority(),
        runtime: testDouble<MarshalRuntimeHost>({
          executeApplication,
          resolveScope: vi.fn<MarshalRuntimeHost["resolveScope"]>(async () =>
            testDouble({ workspacePath: "/resolved/worktree" }),
          ),
        }),
        api: testDouble<MarshalRuntimeApi>({}),
        delivery: testDouble<SelectedSessionDeliveryService>({
          grant: vi.fn<SelectedSessionDeliveryService["grant"]>(async (_owner, targetSessionId) =>
            testDouble({ grantId: "grant-42", targetSessionId }),
          ),
          revokeGrant: vi.fn<SelectedSessionDeliveryService["revokeGrant"]>(async () => undefined),
          resolveGrant: vi.fn<SelectedSessionDeliveryService["resolveGrant"]>(async () =>
            testDouble({ sessionId: "target-session", workspaceName: "marshal" }),
          ),
        }),
        resolveWorkspace: async () => "/workspace",
      });
      const content: RuntimeUiApplicationContent = {
        kind: "application",
        renderId: publication.renderId,
        resource: { uri: publication.resource.uri, mimeType: "text/html" },
        descriptor: publication.application,
      };
      const instance = testDouble<RuntimeUiInstance & { content: RuntimeUiApplicationContent }>({
        instanceId: "app-instance",
        owner:
          ownership === "persistent"
            ? { ...RUNTIME_UI_USER_SCOPE, extensionId: "fixture", applicationId: "app" }
            : {
                sessionId: "target-session",
                workspaceName: "marshal",
                extensionId: "fixture",
                applicationId: "app",
              },
        content,
      });
      if (ownership === "persistent") await host.selectSession(instance, "target-session");
      const result = await host.invoke(
        instance,
        {
          ...instance.owner,
          instanceId: instance.instanceId,
          capability: "fixture.ask",
          input: {},
          idempotencyKey: "w2f2-probe",
        },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ ok: true });
      expect(executeApplication).toHaveBeenCalledOnce();
      const context = executeApplication.mock.calls[0][1];
      // W2-F2: the extension's \u00a77 gate reads context.metadata.grantId (packages/code-review
      // src/ai/grant.ts) \u2014 the host resolved the picker grant into the execution scope but
      // must ALSO convey the grant id itself.
      expect(context.metadata?.grantId).toBe("grant-42");
      // W2-F3: the extension's R1 gate (babysit.arm) requires an affirmative
      // context.metadata.foreground === true on live UI invocations.
      expect(context.metadata?.foreground).toBe(true);
      expect(context.sessionId).toBe("target-session");
      expect(context.workspacePath).toBe("/resolved/worktree");
    },
  );
});
