import { createRuntimeServiceContainer, type InvocationContext } from "@marshal/runtime";
import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../testing/harness";
import type { MarshalRuntimeAgentPort, MarshalRuntimeAgentSummary } from "./agent-orchestration";
import {
  MARSHAL_RUNTIME_BRAIN_DEFAULT_NAME,
  MARSHAL_RUNTIME_BRAIN_DEFAULT_TASK,
  MarshalRuntimeBrainAdapter,
  type MarshalRuntimeBrainPort,
  createRuntimeBrainProvider,
} from "./brain-provider";
import {
  MARSHAL_RUNTIME_PERMISSION,
  type MarshalRuntimeCatalogPort,
  type MarshalRuntimeScope,
} from "./contracts";
import {
  createMarshalHostProviderSource,
  createRuntimeBrainService,
  createRuntimeCatalogService,
} from "./providers";
import { MarshalServiceSymbols } from "./service-symbols";

const timestamp = "2026-08-14T08:00:00.000Z";

function scope(sessionId: string, workspaceName = "Engineering"): MarshalRuntimeScope {
  return { sessionId, workspaceName };
}

function summary(
  id: string,
  role?: "brain",
  workspaceName = "Engineering",
): MarshalRuntimeAgentSummary {
  return {
    id,
    name: id,
    state: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
    workspaceName,
    ...(role ? { runtimeAgentRole: role } : {}),
  };
}

function context(runtimeScope: MarshalRuntimeScope, signal?: AbortSignal): InvocationContext {
  return {
    principal: { id: "test", kind: "agent" },
    identity: { harnessId: "test" },
    scope: { sessionId: runtimeScope.sessionId },
    metadata: { marshalWorkspaceName: runtimeScope.workspaceName },
    ...(signal ? { signal } : {}),
  };
}

function fakeGenericPort(initial: Record<string, MarshalRuntimeAgentSummary[]> = {}) {
  const agents = new Map(Object.entries(initial));
  const list = vi
    .fn<MarshalRuntimeAgentPort["list"]>()
    .mockImplementation(async (runtimeScope) => [...(agents.get(scopeKey(runtimeScope)) ?? [])]);
  const launch = vi.fn<MarshalRuntimeAgentPort["launch"]>().mockImplementation(async (request) => {
    const brain = summary(
      `brain-${request.scope.sessionId}-${request.scope.workspaceName}`,
      request.runtimeAgentRole === "brain" ? request.runtimeAgentRole : undefined,
      request.scope.workspaceName,
    );
    const key = scopeKey(request.scope);
    agents.set(key, [...(agents.get(key) ?? []), brain]);
    return brain;
  });
  const send = vi
    .fn<MarshalRuntimeAgentPort["send"]>()
    .mockImplementation(async (runtimeScope, agentId) => ({
      agent: findAgent(agents, runtimeScope, agentId),
      accepted: true,
      messageId: "message-1",
      deliveryState: "accepted",
    }));
  const transcript = vi
    .fn<MarshalRuntimeAgentPort["transcript"]>()
    .mockImplementation(async (runtimeScope, agentId) => ({
      agent: findAgent(agents, runtimeScope, agentId),
      messageCount: 1,
      showing: 1,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "Done",
          timestamp,
        },
      ],
      result: "Done",
    }));
  const wait = vi
    .fn<MarshalRuntimeAgentPort["wait"]>()
    .mockImplementation(async (runtimeScope, agentId) => ({
      state: "completed",
      agent: findAgent(agents, runtimeScope, agentId),
      result: "Done",
    }));
  const cancel = vi
    .fn<MarshalRuntimeAgentPort["cancel"]>()
    .mockImplementation(async (runtimeScope, agentId) => findAgent(agents, runtimeScope, agentId));
  const port = {
    launch,
    list,
    get: vi
      .fn<MarshalRuntimeAgentPort["get"]>()
      .mockImplementation(
        async (runtimeScope, agentId) =>
          (agents.get(scopeKey(runtimeScope)) ?? []).find((agent) => agent.id === agentId) ?? null,
      ),
    send,
    transcript,
    wait,
    cancel,
    setModel: vi
      .fn<MarshalRuntimeAgentPort["setModel"]>()
      .mockImplementation(async (runtimeScope, agentId) =>
        findAgent(agents, runtimeScope, agentId),
      ),
  } satisfies MarshalRuntimeAgentPort;
  return { agents, port };
}

function fakeBrainPort() {
  const brain = { ...summary("brain-provider", "brain"), runtimeAgentRole: "brain" as const };
  return {
    launch: vi.fn<MarshalRuntimeBrainPort["launch"]>().mockResolvedValue(brain),
    get: vi.fn<MarshalRuntimeBrainPort["get"]>().mockResolvedValue(brain),
    send: vi.fn<MarshalRuntimeBrainPort["send"]>().mockResolvedValue({
      agent: brain,
      accepted: true,
      messageId: "message-1",
      deliveryState: "accepted",
    }),
    transcript: vi.fn<MarshalRuntimeBrainPort["transcript"]>().mockResolvedValue({
      agent: brain,
      messageCount: 0,
      showing: 0,
      messages: [],
    }),
    wait: vi.fn<MarshalRuntimeBrainPort["wait"]>().mockResolvedValue({
      state: "completed",
      agent: brain,
    }),
    cancel: vi.fn<MarshalRuntimeBrainPort["cancel"]>().mockResolvedValue(brain),
  } satisfies MarshalRuntimeBrainPort;
}

describe("Marshal Runtime Brain adapter", () => {
  it("launches once across concurrent providers and recovers the durable role-tagged session", async () => {
    const runtimeScope = scope("concurrent-parent");
    const { port } = fakeGenericPort({
      [scopeKey(runtimeScope)]: [summary("generic-agent")],
    });
    const firstProvider = new MarshalRuntimeBrainAdapter(port);
    const reconstructedProvider = new MarshalRuntimeBrainAdapter(port);

    const [first, concurrent] = await Promise.all([
      firstProvider.launch({ scope: runtimeScope }),
      reconstructedProvider.launch({ scope: runtimeScope, task: "Different concurrent framing" }),
    ]);
    const recovered = await new MarshalRuntimeBrainAdapter(port).launch({
      scope: runtimeScope,
    });

    expect(first.id).toBe(concurrent.id);
    expect(recovered.id).toBe(first.id);
    expect(port.launch).toHaveBeenCalledOnce();
    expect(port.launch).toHaveBeenCalledWith({
      scope: runtimeScope,
      task: MARSHAL_RUNTIME_BRAIN_DEFAULT_TASK,
      idempotencyKey: "marshal.brain.v1",
      name: MARSHAL_RUNTIME_BRAIN_DEFAULT_NAME,
      agentName: undefined,
      model: undefined,
      reasoningEffort: undefined,
      soul: undefined,
      runtimeAgentRole: "brain",
    });
  });

  it("discovers only Brain-tagged agents within the exact parent and workspace scope", async () => {
    const parent = scope("isolated-parent");
    const otherParent = scope("other-parent");
    const otherWorkspace = scope("isolated-parent", "Research");
    const { port } = fakeGenericPort({
      [scopeKey(parent)]: [summary("generic"), summary("brain-parent", "brain")],
      [scopeKey(otherParent)]: [summary("brain-other-parent", "brain")],
      [scopeKey(otherWorkspace)]: [summary("brain-other-workspace", "brain", "Research")],
    });
    const adapter = new MarshalRuntimeBrainAdapter(port);

    await expect(adapter.get(parent)).resolves.toMatchObject({ id: "brain-parent" });
    await expect(adapter.get(otherParent)).resolves.toMatchObject({ id: "brain-other-parent" });
    await expect(adapter.get(otherWorkspace)).resolves.toMatchObject({
      id: "brain-other-workspace",
    });
    expect(port.list).toHaveBeenCalledWith(parent, undefined);
    expect(port.list).toHaveBeenCalledWith(otherParent, undefined);
    expect(port.list).toHaveBeenCalledWith(otherWorkspace, undefined);
  });

  it("rejects duplicate durable Brains instead of choosing one", async () => {
    const runtimeScope = scope("duplicate-parent");
    const { port } = fakeGenericPort({
      [scopeKey(runtimeScope)]: [summary("brain-1", "brain"), summary("brain-2", "brain")],
    });

    await expect(new MarshalRuntimeBrainAdapter(port).get(runtimeScope)).rejects.toMatchObject({
      code: "operation_failed",
    });
    expect(port.launch).not.toHaveBeenCalled();
  });

  it("delegates send, transcript, wait, and cancel to ordinary generic operations", async () => {
    const runtimeScope = scope("delegation-parent");
    const brain = summary("brain-delegation", "brain");
    const { port } = fakeGenericPort({ [scopeKey(runtimeScope)]: [brain] });
    const adapter = new MarshalRuntimeBrainAdapter(port);
    const controller = new AbortController();

    await adapter.send(runtimeScope, "Report status", "interrupt", controller.signal);
    await adapter.transcript(runtimeScope, 7, controller.signal);
    await adapter.wait(runtimeScope, {
      messageId: "message-1",
      timeoutMs: 2_000,
      signal: controller.signal,
    });
    await adapter.cancel(runtimeScope, controller.signal);

    expect(port.send).toHaveBeenCalledWith(
      runtimeScope,
      brain.id,
      "Report status",
      "interrupt",
      controller.signal,
    );
    expect(port.transcript).toHaveBeenCalledWith(runtimeScope, brain.id, 7, controller.signal);
    expect(port.wait).toHaveBeenCalledWith(runtimeScope, brain.id, {
      messageId: "message-1",
      timeoutMs: 2_000,
      signal: controller.signal,
    });
    expect(port.cancel).toHaveBeenCalledWith(runtimeScope, brain.id, controller.signal);
  });

  it("propagates failures and keeps abort behavior explicit without duplicating launch", async () => {
    const missingScope = scope("missing-parent");
    const missing = fakeGenericPort();
    await expect(
      new MarshalRuntimeBrainAdapter(missing.port).send(missingScope, "Hello", "queue"),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(missing.port.send).not.toHaveBeenCalled();

    const cancelScope = scope("cancel-parent");
    const cancelHarness = fakeGenericPort({
      [scopeKey(cancelScope)]: [summary("brain-cancel", "brain")],
    });
    cancelHarness.port.cancel.mockRejectedValueOnce(new Error("cancel failed"));
    await expect(
      new MarshalRuntimeBrainAdapter(cancelHarness.port).cancel(cancelScope),
    ).rejects.toThrow("cancel failed");

    const abortedBeforeStart = new AbortController();
    abortedBeforeStart.abort();
    await expect(
      new MarshalRuntimeBrainAdapter(missing.port).launch({
        scope: scope("pre-aborted-parent"),
        signal: abortedBeforeStart.signal,
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(missing.port.launch).not.toHaveBeenCalled();

    const inFlightScope = scope("in-flight-abort-parent");
    const inFlight = fakeGenericPort();
    let finishLaunch: ((agent: MarshalRuntimeAgentSummary) => void) | undefined;
    inFlight.port.launch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLaunch = resolve;
        }),
    );
    const adapter = new MarshalRuntimeBrainAdapter(inFlight.port);
    const controller = new AbortController();
    const launch = adapter.launch({ scope: inFlightScope, signal: controller.signal });
    await vi.waitFor(() => expect(inFlight.port.launch).toHaveBeenCalledOnce());
    controller.abort();
    await expect(launch).rejects.toMatchObject({ code: "aborted" });
    const launchedBrain = summary("brain-after-abort", "brain");
    inFlight.agents.set(scopeKey(inFlightScope), [launchedBrain]);
    finishLaunch?.(launchedBrain);
    await expect(adapter.launch({ scope: inFlightScope })).resolves.toMatchObject({
      id: launchedBrain.id,
    });
    expect(inFlight.port.launch).toHaveBeenCalledOnce();
  });
});

describe("Marshal Runtime Brain capability provider", () => {
  it("publishes closed role capabilities, permissions, and host discovery", async () => {
    const brain = fakeBrainPort();
    const provider = createRuntimeBrainProvider(brain);
    const descriptors = await provider.list(context(scope("provider-parent")));
    const catalog = testDouble<MarshalRuntimeCatalogPort>({
      listTools: () => [],
      listSkills: () => [],
      getSkill: () => null,
      listWorkspaces: () => [],
      getSessionContext: async () => null,
    });
    const services = createRuntimeServiceContainer();
    await services.bind(MarshalServiceSymbols.catalog, {
      useValue: createRuntimeCatalogService(catalog),
    });
    await services.bind(MarshalServiceSymbols.brain, {
      useValue: createRuntimeBrainService(brain),
    });
    const hostSource = createMarshalHostProviderSource(services);
    const registration = await hostSource(testDouble<Parameters<typeof hostSource>[0]>({}));
    if (Array.isArray(registration) || !("providers" in registration)) {
      throw new Error("Marshal host provider source did not return a provider bundle.");
    }

    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      "marshal.brain.launch",
      "marshal.brain.get",
      "marshal.brain.send",
      "marshal.brain.transcript",
      "marshal.brain.wait",
      "marshal.brain.cancel",
    ]);
    expect(
      descriptors.flatMap(
        (descriptor) => descriptor.permissions?.map((permission) => permission.permission) ?? [],
      ),
    ).toEqual([
      MARSHAL_RUNTIME_PERMISSION.brainLaunch,
      MARSHAL_RUNTIME_PERMISSION.brainRead,
      MARSHAL_RUNTIME_PERMISSION.brainMessage,
      MARSHAL_RUNTIME_PERMISSION.brainRead,
      MARSHAL_RUNTIME_PERMISSION.brainRead,
      MARSHAL_RUNTIME_PERMISSION.brainCancel,
    ]);
    for (const descriptor of descriptors) {
      expect(descriptor.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(descriptor.outputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
    expect(registration.providers.map((candidate) => candidate.id)).toContain("marshal.brain");
    const registeredBrain = registration.providers.find(
      (candidate) => candidate.id === "marshal.brain",
    );
    if (!registeredBrain) throw new Error("Marshal Brain provider was not registered.");
    await registeredBrain.invoke(
      "marshal.brain.launch",
      {},
      {
        ...context(scope("gateway-parent")),
        metadata: {
          marshalWorkspaceName: "Engineering",
          runtimeId: "gateway",
          backendOrigin: "gateway",
        },
      },
    );
    const launchScope = brain.launch.mock.calls.at(-1)?.[0].scope;
    expect(Reflect.get(launchScope ?? {}, "runtimeId")).toBe("gateway");
    expect(Reflect.get(launchScope ?? {}, "backendOrigin")).toBe("gateway");
  });

  it("passes typed scope and AbortSignal while rejecting unknown input and failures", async () => {
    const runtimeScope = scope("provider-delegation-parent");
    const brain = fakeBrainPort();
    const provider = createRuntimeBrainProvider(brain);
    const controller = new AbortController();

    await provider.invoke(
      "marshal.brain.launch",
      { task: "Investigate", reasoningEffort: "high" },
      context(runtimeScope, controller.signal),
    );
    expect(brain.launch).toHaveBeenCalledWith({
      scope: runtimeScope,
      task: "Investigate",
      reasoningEffort: "high",
      signal: controller.signal,
    });

    await provider.invoke(
      "marshal.brain.wait",
      { messageId: "message-1", timeoutMs: 1_000 },
      context(runtimeScope, controller.signal),
    );
    expect(brain.wait).toHaveBeenCalledWith(runtimeScope, {
      messageId: "message-1",
      timeoutMs: 1_000,
      signal: controller.signal,
    });

    await expect(
      provider.invoke("marshal.brain.get", { agentId: "generic" }, context(runtimeScope)),
    ).rejects.toThrow("Unexpected Marshal Brain input property");
    brain.cancel.mockRejectedValueOnce(new Error("backend cancellation failed"));
    await expect(
      provider.invoke("marshal.brain.cancel", {}, context(runtimeScope)),
    ).rejects.toThrow("backend cancellation failed");
  });
});

function scopeKey(runtimeScope: MarshalRuntimeScope): string {
  return `${runtimeScope.sessionId}\0${runtimeScope.workspaceName.toLowerCase()}`;
}

function findAgent(
  agents: ReadonlyMap<string, readonly MarshalRuntimeAgentSummary[]>,
  runtimeScope: MarshalRuntimeScope,
  agentId: string,
): MarshalRuntimeAgentSummary {
  const agent = (agents.get(scopeKey(runtimeScope)) ?? []).find(
    (candidate) => candidate.id === agentId,
  );
  if (!agent) throw Object.assign(new Error("not found"), { code: "not_found" });
  return agent;
}
