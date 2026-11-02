import type { InvocationContext } from "@marshal/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentMessageApiResult,
  SessionMessage,
  SessionMetadata,
  TurnEvent,
} from "../../common/marshal-ipc-contract";
import type { PersistedSession } from "../session-store";
import { testDouble } from "../testing/harness";
import {
  type MarshalRuntimeAgentPort,
  type MarshalRuntimeAgentSessionPort,
  type MarshalRuntimeAgentSummary,
  SessionManagerRuntimeAgentAdapter,
} from "./agent-orchestration";
import { createRuntimeAgentProvider } from "./agent-provider";
import type { MarshalRuntimeScope } from "./contracts";

const scope: MarshalRuntimeScope = {
  sessionId: "parent-1",
  workspaceName: "Engineering",
};
const timestamp = "2026-08-14T08:00:00.000Z";

function metadata(id: string, overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return testDouble<SessionMetadata>({
    id,
    name: id,
    createdAt: timestamp,
    updatedAt: timestamp,
    hasUnread: false,
    isActive: false,
    source: "subagent",
    parentSessionId: scope.sessionId,
    workspaceName: scope.workspaceName,
    ...overrides,
  });
}

function persisted(id: string, overrides: Partial<PersistedSession> = {}): PersistedSession {
  return testDouble<PersistedSession>({
    ...metadata(id),
    messages: [],
    ...overrides,
  });
}

function summary(id = "agent-1"): MarshalRuntimeAgentSummary {
  return {
    id,
    name: id,
    state: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
    workspaceName: scope.workspaceName,
  };
}

function invocationContext(signal?: AbortSignal): InvocationContext {
  return {
    principal: { id: "test", kind: "agent" },
    identity: { harnessId: "test" },
    scope: { sessionId: scope.sessionId },
    metadata: { marshalWorkspaceName: scope.workspaceName },
    ...(signal ? { signal } : {}),
  };
}

function fakeAgentPort() {
  const agent = summary();
  return {
    launch: vi.fn<MarshalRuntimeAgentPort["launch"]>().mockResolvedValue(agent),
    list: vi.fn<MarshalRuntimeAgentPort["list"]>().mockResolvedValue([agent]),
    get: vi.fn<MarshalRuntimeAgentPort["get"]>().mockResolvedValue(agent),
    send: vi.fn<MarshalRuntimeAgentPort["send"]>().mockResolvedValue({
      agent,
      accepted: true,
      messageId: "message-1",
      deliveryState: "accepted",
    }),
    transcript: vi.fn<MarshalRuntimeAgentPort["transcript"]>().mockResolvedValue({
      agent,
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
    }),
    wait: vi.fn<MarshalRuntimeAgentPort["wait"]>().mockResolvedValue({
      state: "completed",
      agent,
      result: "Done",
      usage: { tokens: 42, costUsd: 0.25 },
    }),
    cancel: vi.fn<MarshalRuntimeAgentPort["cancel"]>().mockResolvedValue(agent),
    setModel: vi.fn<MarshalRuntimeAgentPort["setModel"]>().mockResolvedValue(agent),
  } satisfies MarshalRuntimeAgentPort;
}

function sessionHarness() {
  const owner = persisted(scope.sessionId, {
    source: "user",
    scopedSkills: ["skill-a"],
    scopedMcp: ["server-a"],
  });
  const owned = persisted("owned-1");
  const sessions = new Map<string, PersistedSession>([
    [owner.id, owner],
    [owned.id, owned],
  ]);
  const indexed: SessionMetadata[] = [
    owned,
    metadata("workflow-1", { source: "workflow-agent" }),
    metadata("other-parent", { parentSessionId: "parent-2" }),
    metadata("other-workspace", { workspaceName: "Research" }),
  ];
  const listeners = new Set<(sessionId: string, event: TurnEvent) => void>();
  let busy = false;
  let cancellationRequested = false;
  let pendingAgentMessage = false;
  let created = 0;
  const sendResult: AgentMessageApiResult = {
    success: true,
    accepted: true,
    messageId: "message-1",
    deliveryState: "accepted",
  };
  const port = {
    getSessionAsync: vi
      .fn<MarshalRuntimeAgentSessionPort["getSessionAsync"]>()
      .mockImplementation(async (id) => sessions.get(id) ?? null),
    listSubagentSessions: vi
      .fn<MarshalRuntimeAgentSessionPort["listSubagentSessions"]>()
      .mockImplementation(() => [...indexed]),
    isSessionBusy: vi
      .fn<MarshalRuntimeAgentSessionPort["isSessionBusy"]>()
      .mockImplementation(() => busy),
    isSessionCancellationRequested: vi
      .fn<NonNullable<MarshalRuntimeAgentSessionPort["isSessionCancellationRequested"]>>()
      .mockImplementation(() => cancellationRequested),
    hasPendingAgentMessage: vi
      .fn<NonNullable<MarshalRuntimeAgentSessionPort["hasPendingAgentMessage"]>>()
      .mockImplementation(() => pendingAgentMessage),
    createSubagentSession: vi
      .fn<MarshalRuntimeAgentSessionPort["createSubagentSession"]>()
      .mockImplementation(async (request) => {
        created++;
        const child = persisted(`created-${created}`, {
          name: request.name ?? `created-${created}`,
          source: "subagent",
          parentSessionId: request.parentSessionId,
          workspaceName: request.workspaceName,
          repoPath: request.repoPath,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          soul: request.soul,
          runtimeAgentRole: request.runtimeAgentRole,
        });
        sessions.set(child.id, child);
        indexed.push(child);
        return { session: child };
      }),
    sendMessageToSubagent: vi
      .fn<MarshalRuntimeAgentSessionPort["sendMessageToSubagent"]>()
      .mockResolvedValue(sendResult),
    assignRuntimeAgentRole: vi
      .fn<MarshalRuntimeAgentSessionPort["assignRuntimeAgentRole"]>()
      .mockImplementation(async (sessionId, role) => {
        const session = sessions.get(sessionId);
        if (session) session.runtimeAgentRole = role;
      }),
    sendMessage: vi
      .fn<MarshalRuntimeAgentSessionPort["sendMessage"]>()
      .mockResolvedValue(undefined),
    waitForAgentMessageBackendAccepted: vi
      .fn<MarshalRuntimeAgentSessionPort["waitForAgentMessageBackendAccepted"]>()
      .mockResolvedValue(undefined),
    cancelTurn: vi.fn<MarshalRuntimeAgentSessionPort["cancelTurn"]>().mockResolvedValue(undefined),
    addEventListener: vi
      .fn<MarshalRuntimeAgentSessionPort["addEventListener"]>()
      .mockImplementation((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
  } satisfies MarshalRuntimeAgentSessionPort;
  return {
    adapter: new SessionManagerRuntimeAgentAdapter(port),
    indexed,
    listeners,
    port,
    sessions,
    setBusy(value: boolean) {
      busy = value;
    },
    setCancellationRequested(value: boolean) {
      cancellationRequested = value;
    },
    setPendingAgentMessage(value: boolean) {
      pendingAgentMessage = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Runtime ordinary-agent capability provider", () => {
  it("passes an explicit runtime account from the launch capability to session creation", async () => {
    const harness = sessionHarness();
    const provider = createRuntimeAgentProvider(harness.adapter);
    await provider.invoke(
      "marshal.agent.launch",
      {
        task: "Run the experiment",
        idempotencyKey: "account-experiment",
        runtime: "claude@work",
        model: "opus",
      },
      invocationContext(),
    );
    expect(harness.port.createSubagentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: "claude@work",
        model: "opus",
      }),
    );
  });

  it("publishes only closed ordinary-agent capabilities", async () => {
    const provider = createRuntimeAgentProvider(fakeAgentPort());
    const descriptors = await provider.list(invocationContext());

    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      "marshal.agent.launch",
      "marshal.agent.list",
      "marshal.agent.get",
      "marshal.agent.send",
      "marshal.agent.transcript",
      "marshal.agent.wait",
      "marshal.agent.cancel",
      "marshal.agent.setModel",
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
  });

  it("passes parent scope, cancellation, and typed inputs to the adapter", async () => {
    const adapter = fakeAgentPort();
    const provider = createRuntimeAgentProvider(adapter);
    const controller = new AbortController();

    await expect(
      provider.invoke(
        "marshal.agent.launch",
        {
          task: "Inspect the implementation",
          idempotencyKey: "launch-1",
          sessionId: scope.sessionId,
          reasoningEffort: "high",
        },
        invocationContext(controller.signal),
      ),
    ).resolves.toMatchObject({ output: { agent: { id: "agent-1" } } });
    expect(adapter.launch).toHaveBeenCalledWith({
      scope,
      task: "Inspect the implementation",
      idempotencyKey: "launch-1",
      sessionId: scope.sessionId,
      reasoningEffort: "high",
      signal: controller.signal,
    });

    await provider.invoke(
      "marshal.agent.send",
      { agentId: "agent-1", message: "Report status", deliveryMode: "interrupt" },
      invocationContext(controller.signal),
    );
    expect(adapter.send).toHaveBeenCalledWith(
      scope,
      "agent-1",
      "Report status",
      "interrupt",
      controller.signal,
    );

    await expect(
      provider.invoke(
        "marshal.agent.wait",
        { agentId: "agent-1", timeoutMs: 1000 },
        invocationContext(controller.signal),
      ),
    ).resolves.toMatchObject({
      output: { usage: { tokens: 42, costUsd: 0.25 } },
    });

    await expect(
      provider.invoke("marshal.agent.list", { unrelated: true }, invocationContext()),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Unexpected Marshal agent input property: unrelated.",
    });
  });

  it("propagates adapter failures instead of returning success-shaped output", async () => {
    const adapter = fakeAgentPort();
    adapter.cancel.mockRejectedValueOnce(new Error("backend cancellation failed"));
    const provider = createRuntimeAgentProvider(adapter);

    await expect(
      provider.invoke("marshal.agent.cancel", { agentId: "agent-1" }, invocationContext()),
    ).rejects.toThrow("backend cancellation failed");
  });
});

describe("SessionManager ordinary-agent adapter", () => {
  it("delegates launches without a host-side idempotency ledger", async () => {
    const { adapter, port } = sessionHarness();
    const request = {
      scope,
      task: "Inspect the implementation",
      idempotencyKey: "launch-1",
      name: "Inspector",
    };

    const first = await adapter.launch(request);
    const replay = await adapter.launch(request);

    expect(replay.id).not.toBe(first.id);
    expect(port.createSubagentSession).toHaveBeenCalledTimes(2);
    expect(port.createSubagentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        task: request.task,
        name: request.name,
        parentSessionId: scope.sessionId,
        workspaceName: scope.workspaceName,
        permissionMode: "allow-all",
        skills: ["skill-a"],
        mcp: ["server-a"],
        source: "subagent",
        runtimeAgentRole: undefined,
        suppressInitialTodoInstruction: true,
        returnAfterBackendAcceptance: true,
        suppressParentReadinessWake: true,
      }),
    );
    await expect(adapter.launch({ ...request, task: "Different task" })).resolves.toMatchObject({
      id: "created-3",
    });
  });

  it("persists the authorized default workspace when the owner omits its normalized name", async () => {
    const { adapter, port, sessions } = sessionHarness();
    const defaultScope = { sessionId: scope.sessionId, workspaceName: "marshal" };
    sessions.set(
      scope.sessionId,
      persisted(scope.sessionId, {
        source: "user",
        workspaceName: undefined,
        scopedSkills: ["skill-a"],
        scopedMcp: ["server-a"],
      }),
    );

    await adapter.launch({
      scope: defaultScope,
      task: "Inspect the default workspace",
      idempotencyKey: "default-workspace",
    });

    expect(port.createSubagentSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceName: "marshal" }),
    );
  });

  it("preserves the authorized origin workspace for recursive launches from a worktree", async () => {
    const { adapter, port, sessions } = sessionHarness();
    sessions.set(
      scope.sessionId,
      persisted(scope.sessionId, {
        source: "subagent",
        workspaceName: undefined,
        originWorkspaceName: scope.workspaceName,
        repoPath: "Q:\\worktrees\\planner",
      }),
    );

    await adapter.launch({
      scope,
      task: "Decompose the implementation",
      idempotencyKey: "recursive-worktree",
      createWorktree: true,
    });

    expect(port.createSubagentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: scope.sessionId,
        workspaceName: scope.workspaceName,
        repoPath: "Q:\\worktrees\\planner",
        createWorktree: true,
      }),
    );
  });

  it("launches a child in a host-resolved workspace while retaining parent ownership", async () => {
    const { adapter, port } = sessionHarness();

    await adapter.launch({
      scope,
      task: "Implement the registered Research task",
      idempotencyKey: "registered-resource",
      workspaceName: "Research",
      repoPath: "Q:\\registered\\Research",
    });

    expect(port.createSubagentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: scope.sessionId,
        workspaceName: "Research",
        repoPath: "Q:\\registered\\Research",
      }),
    );
  });

  it("threads an internal Runtime role through ordinary session creation", async () => {
    const { adapter, port } = sessionHarness();

    await expect(
      adapter.launch({
        scope,
        task: "Act as Brain",
        idempotencyKey: "brain",
        runtimeAgentRole: "brain",
      }),
    ).resolves.toMatchObject({ runtimeAgentRole: "brain" });
    expect(port.createSubagentSession).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeAgentRole: "brain" }),
    );
  });

  it("filters every read and write by parent session and ordinary source", async () => {
    const { adapter, port } = sessionHarness();

    await expect(adapter.list(scope)).resolves.toEqual([
      expect.objectContaining({ id: "owned-1" }),
      expect.objectContaining({ id: "other-workspace" }),
    ]);
    await expect(adapter.get(scope, "workflow-1")).resolves.toBeNull();
    await expect(adapter.get(scope, "other-parent")).resolves.toBeNull();
    await expect(adapter.get(scope, "other-workspace")).resolves.toMatchObject({
      id: "other-workspace",
    });
    await expect(adapter.send(scope, "other-parent", "Hello", "queue")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(port.sendMessageToSubagent).not.toHaveBeenCalled();
    await expect(adapter.list({ ...scope, workspaceName: "Research" })).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("does not report a send as accepted until durable backend acceptance", async () => {
    const { adapter, port } = sessionHarness();
    let markAccepted!: () => void;
    const backendAcceptance = new Promise<void>((resolve) => {
      markAccepted = resolve;
    });
    port.waitForAgentMessageBackendAccepted.mockReturnValueOnce(backendAcceptance);
    let settled = false;

    const sending = adapter.send(scope, "owned-1", "Hello", "queue").finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(port.waitForAgentMessageBackendAccepted).toHaveBeenCalledWith("message-1");
    });
    expect(settled).toBe(false);

    markAccepted();
    await expect(sending).resolves.toMatchObject({
      accepted: true,
      messageId: "message-1",
      deliveryState: "backend-accepted",
    });
  });

  it("recognizes an isolated child by its origin workspace", async () => {
    const { adapter, indexed, sessions } = sessionHarness();
    const child = persisted("isolated-child", {
      workspaceName: undefined,
      originWorkspaceName: scope.workspaceName,
      repoPath: "Q:\\worktrees\\isolated-child",
    });
    indexed.push(child);
    sessions.set(child.id, child);

    await expect(adapter.list(scope)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: child.id,
          repoPath: child.repoPath,
        }),
      ]),
    );
    await expect(adapter.get(scope, child.id)).resolves.toMatchObject({ id: child.id });
  });

  it("returns bounded transcripts and propagates message and cancellation failures", async () => {
    const { adapter, port, sessions } = sessionHarness();
    const messages: SessionMessage[] = [
      { id: "user-1", role: "user", content: "Task", timestamp },
      { id: "assistant-1", role: "assistant", content: "Done", timestamp },
    ];
    sessions.set("owned-1", persisted("owned-1", { messages }));

    await expect(adapter.transcript(scope, "owned-1", 1)).resolves.toMatchObject({
      messageCount: 2,
      showing: 1,
      result: "Done",
      messages: [{ id: "assistant-1" }],
    });

    port.sendMessageToSubagent.mockResolvedValueOnce({
      success: false,
      accepted: false,
      error: "delivery failed",
    });
    await expect(adapter.send(scope, "owned-1", "Hello", "queue")).rejects.toThrow(
      "delivery failed",
    );

    port.cancelTurn.mockRejectedValueOnce(new Error("cancel failed"));
    await expect(adapter.cancel(scope, "owned-1")).rejects.toThrow("cancel failed");
  });

  it("completes an idle wait from the latest assistant result despite trailing system messages", async () => {
    const { adapter, sessions } = sessionHarness();
    sessions.set(
      "owned-1",
      persisted("owned-1", {
        messages: [
          { id: "user-1", role: "user", content: "Task", timestamp },
          { id: "assistant-1", role: "assistant", content: '{"children":[]}', timestamp },
          { id: "system-1", role: "system", content: "Subagent is idle.", timestamp },
        ],
      }),
    );

    await expect(adapter.wait(scope, "owned-1", { timeoutMs: 100 })).resolves.toMatchObject({
      state: "completed",
      result: '{"children":[]}',
    });
  });

  it("does not create a timer when a wait omits timeoutMs", async () => {
    vi.useFakeTimers();
    const { adapter, setBusy } = sessionHarness();
    const controller = new AbortController();
    setBusy(true);

    const waiting = adapter.wait(scope, "owned-1", { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(adapter.getRuntimeAcceptanceDiagnostics().activeWaitTimers).toBe(0);

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
  });

  it("resolves an active wait with the current summary after cancellation", async () => {
    const { adapter, listeners, setBusy, setCancellationRequested } = sessionHarness();
    setBusy(true);
    const waiting = adapter.wait(scope, "owned-1", { timeoutMs: 1_000 });
    await vi.waitFor(() => expect(listeners.size).toBe(1));

    setBusy(false);
    setCancellationRequested(true);
    for (const listener of listeners) {
      listener("owned-1", testDouble<TurnEvent>({ type: "turn:idle" }));
    }

    await expect(waiting).resolves.toMatchObject({
      state: "completed",
      agent: { id: "owned-1", state: "idle" },
    });
    expect(adapter.getRuntimeAcceptanceDiagnostics()).toMatchObject({
      activeWaitListeners: 0,
      activeWaitTimers: 0,
      activeWaitAbortListeners: 0,
    });
  });

  it("cleans event listeners and timers after timeout and abort", async () => {
    vi.useFakeTimers();
    const { adapter, listeners, setBusy } = sessionHarness();
    setBusy(true);

    const timedOut = adapter.wait(scope, "owned-1", { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(listeners.size).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    await expect(timedOut).resolves.toMatchObject({ state: "timeout" });
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(adapter.getRuntimeAcceptanceDiagnostics()).toMatchObject({
      activeWaitListeners: 0,
      activeWaitTimers: 0,
      activeWaitAbortListeners: 0,
    });

    const controller = new AbortController();
    const aborted = adapter.wait(scope, "owned-1", {
      timeoutMs: 100,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(listeners.size).toBe(1);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "aborted" });
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(adapter.getRuntimeAcceptanceDiagnostics()).toMatchObject({
      activeWaitListeners: 0,
      activeWaitTimers: 0,
      activeWaitAbortListeners: 0,
    });
    adapter.dispose();
    expect(listeners.size).toBe(0);
  });
});

describe("Runtime launch tool allowlist", () => {
  const baseInput = { task: "Do the work", idempotencyKey: "launch-allow" };

  it("advertises allowedTools in the launch schema and forwards it to the adapter", async () => {
    const adapter = fakeAgentPort();
    const provider = createRuntimeAgentProvider(adapter);
    const launch = (await provider.list(invocationContext())).find(
      (descriptor) => descriptor.name === "marshal.agent.launch",
    );
    expect(launch?.inputSchema).toMatchObject({
      properties: { allowedTools: { type: "array", uniqueItems: true } },
    });

    await provider.invoke(
      "marshal.agent.launch",
      { ...baseInput, allowedTools: ["runtimeInvoke", "runtimeSearch"] },
      invocationContext(),
    );
    expect(adapter.launch).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTools: ["runtimeInvoke", "runtimeSearch"] }),
    );
  });

  it.each([
    ["a non-array value", "runtimeInvoke"],
    ["an invalid tool name", ["runtime Invoke"]],
    ["a non-string entry", [7]],
    ["duplicate entries", ["runtimeInvoke", "runtimeInvoke"]],
    ["too many entries", Array.from({ length: 65 }, (_, index) => `tool${index}`)],
  ])("rejects %s", async (_label, allowedTools) => {
    const adapter = fakeAgentPort();
    const provider = createRuntimeAgentProvider(adapter);
    await expect(
      provider.invoke("marshal.agent.launch", { ...baseInput, allowedTools }, invocationContext()),
    ).rejects.toThrow(/allowedTools/);
    expect(adapter.launch).not.toHaveBeenCalled();
  });

  it("refuses to restrict an already running session", async () => {
    const adapter = fakeAgentPort();
    const provider = createRuntimeAgentProvider(adapter);
    await expect(
      provider.invoke(
        "marshal.agent.launch",
        { ...baseInput, sessionId: scope.sessionId, allowedTools: ["runtimeInvoke"] },
        invocationContext(),
      ),
    ).rejects.toThrow(/already running/);
    expect(adapter.launch).not.toHaveBeenCalled();
  });

  it("creates the child with the allowlist and no skills or MCP servers", async () => {
    const { adapter, port } = sessionHarness();
    await adapter.launch({ scope, ...baseInput, allowedTools: ["runtimeInvoke"] });
    expect(port.createSubagentSession).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTools: ["runtimeInvoke"], skills: [], mcp: [] }),
    );
  });

  it("keeps inherited skills and MCP scope when no allowlist is given", async () => {
    const { adapter, port } = sessionHarness();
    await adapter.launch({ scope, ...baseInput });
    const args = port.createSubagentSession.mock.calls[0]?.[0];
    expect(args).toMatchObject({ skills: ["skill-a"], mcp: ["server-a"] });
    expect(args).not.toHaveProperty("allowedTools");
  });
});

describe("Runtime launch workspace defaults", () => {
  const request = { task: "Do the work", idempotencyKey: "workspace-default" };

  async function launchedWorkspace(
    owner: Partial<PersistedSession>,
    extra: { workspaceName?: string; repoPath?: string; createWorktree?: boolean } = {},
  ) {
    const { adapter, port, sessions } = sessionHarness();
    sessions.set(scope.sessionId, persisted(scope.sessionId, { source: "user", ...owner }));
    await adapter.launch({ scope, ...request, ...extra });
    const args = port.createSubagentSession.mock.calls[0]?.[0];
    return { workspaceName: args?.workspaceName, repoPath: args?.repoPath };
  }

  it("uses only the scope workspace when the caller and owner name no root", async () => {
    await expect(launchedWorkspace({})).resolves.toEqual({
      workspaceName: scope.workspaceName,
      repoPath: undefined,
    });
  });

  it("uses only the owner repoPath when the owner runs outside a registered workspace", async () => {
    await expect(
      launchedWorkspace({
        workspaceName: undefined,
        originWorkspaceName: scope.workspaceName,
        repoPath: "/tmp/owner-worktree",
      }),
    ).resolves.toEqual({ workspaceName: undefined, repoPath: "/tmp/owner-worktree" });
  });

  it("does not add the owner repoPath to a caller-supplied workspaceName", async () => {
    await expect(
      launchedWorkspace(
        {
          originWorkspaceName: scope.workspaceName,
          workspaceName: undefined,
          repoPath: "/tmp/owner-worktree",
        },
        { workspaceName: "Research" },
      ),
    ).resolves.toEqual({ workspaceName: "Research", repoPath: undefined });
  });

  it("does not add the scope workspace to a caller-supplied repoPath", async () => {
    await expect(launchedWorkspace({}, { repoPath: "/tmp/other" })).resolves.toEqual({
      workspaceName: undefined,
      repoPath: "/tmp/other",
    });
  });

  it("passes both through when the caller supplies both", async () => {
    await expect(
      launchedWorkspace({}, { workspaceName: "Research", repoPath: "/tmp/research" }),
    ).resolves.toEqual({ workspaceName: "Research", repoPath: "/tmp/research" });
  });
});

describe("marshal.agent.setModel", () => {
  it("forwards the agent, model, and reasoning effort to the adapter", async () => {
    const adapter = fakeAgentPort();
    const provider = createRuntimeAgentProvider(adapter);

    await expect(
      provider.invoke(
        "marshal.agent.setModel",
        { agentId: "agent-1", model: "gpt-5.6-luna", reasoningEffort: "low" },
        invocationContext(),
      ),
    ).resolves.toMatchObject({ output: { agent: { id: "agent-1" } } });
    expect(adapter.setModel).toHaveBeenCalledWith(
      scope,
      "agent-1",
      "gpt-5.6-luna",
      "low",
      undefined,
    );
  });

  it("declares the same permission and risk as marshal.agent.send", async () => {
    const provider = createRuntimeAgentProvider(fakeAgentPort());
    const descriptors = await provider.list(invocationContext());
    const permissionsOf = (name: string) =>
      descriptors.find((descriptor) => descriptor.name === name)?.permissions;

    expect(permissionsOf("marshal.agent.setModel")).toEqual(permissionsOf("marshal.agent.send"));
  });

  it("rejects unknown input and invalid reasoning effort before reaching the adapter", async () => {
    const adapter = fakeAgentPort();
    const provider = createRuntimeAgentProvider(adapter);

    await expect(
      provider.invoke(
        "marshal.agent.setModel",
        { agentId: "agent-1", model: "gpt-5.6-luna", runtime: "cursor" },
        invocationContext(),
      ),
    ).rejects.toThrow("Unexpected Marshal agent input property: runtime.");
    await expect(
      provider.invoke(
        "marshal.agent.setModel",
        { agentId: "agent-1", model: "gpt-5.6-luna", reasoningEffort: "extreme" },
        invocationContext(),
      ),
    ).rejects.toThrow("reasoningEffort must be one of");
    expect(adapter.setModel).not.toHaveBeenCalled();
  });

  function switchingHarness() {
    const harness = sessionHarness();
    const effective = new Map<string, string>();
    const switchSessionModel = vi
      .fn<NonNullable<MarshalRuntimeAgentSessionPort["switchSessionModel"]>>()
      .mockImplementation(async (sessionId, model) => {
        const routed = model.startsWith("gpt-") ? `cursor:${model}` : model;
        effective.set(sessionId, routed);
        return routed;
      });
    const port = {
      ...harness.port,
      switchSessionModel,
      getEffectiveSessionModel: (sessionId: string) =>
        effective.get(sessionId) ?? "claude-opus-5-5[1m]",
    } satisfies MarshalRuntimeAgentSessionPort;
    return { ...harness, adapter: new SessionManagerRuntimeAgentAdapter(port), switchSessionModel };
  }

  it("switches an owned idle agent in place and reports its effective model", async () => {
    const { adapter, switchSessionModel } = switchingHarness();

    await expect(adapter.get(scope, "owned-1")).resolves.toMatchObject({
      model: "claude-opus-5-5[1m]",
    });
    await expect(adapter.setModel(scope, "owned-1", "gpt-5.6-luna", "low")).resolves.toMatchObject({
      id: "owned-1",
      model: "cursor:gpt-5.6-luna",
    });
    expect(switchSessionModel).toHaveBeenCalledWith("owned-1", "gpt-5.6-luna", {
      reasoningEffort: "low",
      liveSwitch: true,
    });
    await expect(adapter.list(scope)).resolves.toContainEqual(
      expect.objectContaining({ id: "owned-1", model: "cursor:gpt-5.6-luna" }),
    );
  });

  it("applies the same ownership checks as send", async () => {
    const { adapter, switchSessionModel } = switchingHarness();

    for (const agentId of ["workflow-1", "other-parent", "missing"]) {
      // eslint-disable-next-line no-await-in-loop -- each rejection is asserted in order
      await expect(adapter.setModel(scope, agentId, "gpt-5.6-luna")).rejects.toMatchObject({
        code: "not_found",
      });
    }
    await expect(
      adapter.setModel({ ...scope, workspaceName: "Research" }, "owned-1", "gpt-5.6-luna"),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(switchSessionModel).not.toHaveBeenCalled();
  });

  it("hands a busy agent's switch to the session manager, which defers it", async () => {
    const { adapter, setBusy, switchSessionModel } = switchingHarness();
    setBusy(true);

    await adapter.setModel(scope, "owned-1", "gpt-5.6-luna");
    expect(switchSessionModel).toHaveBeenCalledWith(
      "owned-1",
      "gpt-5.6-luna",
      expect.objectContaining({ liveSwitch: true }),
    );
  });

  it("reports a failed switch as operation_failed", async () => {
    const { adapter, switchSessionModel } = switchingHarness();
    switchSessionModel.mockRejectedValueOnce(
      new Error('Model "gpt-9" is not available in the cursor runtime.'),
    );

    await expect(adapter.setModel(scope, "owned-1", "gpt-9")).rejects.toMatchObject({
      code: "operation_failed",
      message: 'Model "gpt-9" is not available in the cursor runtime.',
    });
  });
});
