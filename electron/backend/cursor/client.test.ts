import type { Run, SDKAgent } from "@cursor/sdk";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeTool } from "../runtime-contract";
import { CursorRuntimeClient } from "./client";
import { CURSOR_API_KEY_ENV } from "./constants";
import type { CursorSdkFacade, SdkCredentialStore, StoredSdkCredentials } from "./sdk-facade";

class MemoryStore implements SdkCredentialStore {
  private credentials: StoredSdkCredentials | undefined;

  async load(): Promise<StoredSdkCredentials | undefined> {
    return this.credentials;
  }

  async save(credentials: StoredSdkCredentials): Promise<void> {
    this.credentials = credentials;
  }

  async clear(): Promise<void> {
    this.credentials = undefined;
  }
}

function fakeAgent(agentId = "agent-1"): SDKAgent {
  return {
    agentId,
    model: { id: "composer-2.5" },
    send: vi.fn<SDKAgent["send"]>(),
    close: vi.fn<SDKAgent["close"]>(),
    reload: vi.fn<SDKAgent["reload"]>(async () => undefined),
    [Symbol.asyncDispose]: vi.fn<SDKAgent[typeof Symbol.asyncDispose]>(async () => undefined),
    listArtifacts: vi.fn<SDKAgent["listArtifacts"]>(async () => []),
    downloadArtifact: vi.fn<SDKAgent["downloadArtifact"]>(),
    getUsage: vi.fn<SDKAgent["getUsage"]>(),
  };
}

function fakeRun(id: string, status: Run["status"]): Run {
  return {
    id,
    agentId: "agent-1",
    status,
    supports: vi.fn<Run["supports"]>(() => true),
    unsupportedReason: vi.fn<Run["unsupportedReason"]>(() => undefined),
    stream: vi.fn<Run["stream"]>(),
    conversation: vi.fn<Run["conversation"]>(),
    wait: vi.fn<Run["wait"]>(),
    cancel: vi.fn<Run["cancel"]>(),
    onDidChangeStatus: vi.fn<Run["onDidChangeStatus"]>(() => () => undefined),
  };
}

function fakeSdk(overrides: Partial<CursorSdkFacade> = {}): CursorSdkFacade {
  return {
    createAgent: vi.fn<CursorSdkFacade["createAgent"]>(async () => fakeAgent()),
    resumeAgent: vi.fn<CursorSdkFacade["resumeAgent"]>(async () => fakeAgent("agent-resume")),
    listRuns: vi.fn<CursorSdkFacade["listRuns"]>(async () => []),
    cancelRun: vi.fn<CursorSdkFacade["cancelRun"]>(async () => undefined),
    listModels: vi.fn<CursorSdkFacade["listModels"]>(async () => [
      { id: "composer-2.5", displayName: "Composer 2.5" },
    ]),
    me: vi.fn<CursorSdkFacade["me"]>(),
    login: vi.fn<CursorSdkFacade["login"]>(),
    logout: vi.fn<CursorSdkFacade["logout"]>(async () => undefined),
    authStatus: vi.fn<CursorSdkFacade["authStatus"]>(),
    createFileCredentialStore: vi.fn<CursorSdkFacade["createFileCredentialStore"]>(),
    ...overrides,
  };
}

describe("CursorRuntimeClient usage", () => {
  it("reports no plan usage because the Cursor SDK exposes none", async () => {
    const client = new CursorRuntimeClient(fakeSdk(), {
      workspaceDir: "/tmp/workspace",
      env: {},
      store: new MemoryStore(),
    });
    await expect(client.getUsage()).resolves.toBeNull();
  });
});

describe("CursorRuntimeClient authentication", () => {
  it("reports unauthenticated when no key is stored or exported", async () => {
    const client = new CursorRuntimeClient(fakeSdk(), {
      workspaceDir: "/tmp/workspace",
      env: {},
      store: new MemoryStore(),
    });
    await expect(client.getAuthStatus()).resolves.toMatchObject({ isAuthenticated: false });
  });

  it("accepts a pasted API key and treats CURSOR_API_KEY as authenticated", async () => {
    const store = new MemoryStore();
    const client = new CursorRuntimeClient(fakeSdk(), {
      workspaceDir: "/tmp/workspace",
      env: {},
      store,
    });
    await expect(client.login({ type: "api-key", apiKey: "cursor-test-key" })).resolves.toEqual({
      status: "authenticated",
    });
    await expect(client.getAuthStatus()).resolves.toMatchObject({
      isAuthenticated: true,
      login: "api-key",
    });

    const envClient = new CursorRuntimeClient(fakeSdk(), {
      workspaceDir: "/tmp/workspace",
      env: { [CURSOR_API_KEY_ENV]: "env-key" },
      store: new MemoryStore(),
    });
    await expect(envClient.getAuthStatus()).resolves.toMatchObject({ isAuthenticated: true });
  });

  it("rejects device-code login", async () => {
    const client = new CursorRuntimeClient(fakeSdk(), {
      workspaceDir: "/tmp/workspace",
      env: {},
      store: new MemoryStore(),
    });
    await expect(client.login({ type: "device-code" })).rejects.toThrow(
      "Cursor does not support device-code authentication",
    );
  });
});

describe("CursorRuntimeClient sessions", () => {
  it.each(["disconnect", "destroy"] as const)(
    "releases a Cursor session after %s so it can resume again",
    async (action) => {
      const sdk = fakeSdk({
        resumeAgent: vi.fn<CursorSdkFacade["resumeAgent"]>(async (id) => fakeAgent(id)),
      });
      const client = new CursorRuntimeClient(sdk, {
        workspaceDir: "/tmp/workspace",
        env: { [CURSOR_API_KEY_ENV]: "env-key" },
        store: new MemoryStore(),
      });
      const first = await client.resumeSession("legacy-agent", {});
      await first[action]();
      const second = await client.resumeSession("legacy-agent", {});
      expect(second).not.toBe(first);
      expect(sdk.resumeAgent).toHaveBeenCalledTimes(2);
      await second.disconnect();
    },
  );

  it("reuses an active session for context export without reopening or closing it", async () => {
    const agent = fakeAgent();
    const sdk = fakeSdk({ createAgent: vi.fn<CursorSdkFacade["createAgent"]>(async () => agent) });
    const client = new CursorRuntimeClient(sdk, {
      workspaceDir: "/tmp/workspace",
      env: { [CURSOR_API_KEY_ENV]: "env-key" },
      store: new MemoryStore(),
    });
    const state = {
      version: 1 as const,
      sourceRuntimeId: "cursor",
      messages: [{ role: "user" as const, content: "Retain this decision" }],
    };
    const session = await client.createSession({ conversationState: state });
    await expect(
      client.readConversationState(session.sessionId, "/tmp/workspace", { allowCompaction: true }),
    ).resolves.toEqual(state);
    expect(sdk.resumeAgent).not.toHaveBeenCalled();
    expect(sdk.listRuns).not.toHaveBeenCalled();
    expect(agent[Symbol.asyncDispose]).not.toHaveBeenCalled();
    await session.disconnect();
  });

  it("retries a failed legacy handoff without leaving the temporary agent active", async () => {
    let exposeSummary = false;
    const agents: SDKAgent[] = [];
    const sdk = fakeSdk({
      resumeAgent: vi.fn<CursorSdkFacade["resumeAgent"]>(async (id) => {
        const agent = fakeAgent(id);
        vi.mocked(agent.send).mockImplementation(async (_prompt, options) => {
          if (exposeSummary)
            await options?.onDelta?.({
              update: { type: "summary", summary: "Recovered legacy context" },
            });
          const run = fakeRun("summary-run", "finished");
          run.stream = async function* () {
            yield* [];
          };
          run.wait = async () => ({ id: run.id, status: "finished" });
          return run;
        });
        agents.push(agent);
        return agent;
      }),
    });
    const client = new CursorRuntimeClient(sdk, {
      workspaceDir: "/tmp/workspace",
      env: { [CURSOR_API_KEY_ENV]: "env-key" },
      store: new MemoryStore(),
    });
    await expect(
      client.readConversationState("legacy-agent", "/tmp/workspace", { allowCompaction: true }),
    ).rejects.toThrow("readable compaction checkpoint");
    expect(agents[0][Symbol.asyncDispose]).toHaveBeenCalledOnce();
    exposeSummary = true;
    await expect(
      client.readConversationState("legacy-agent", "/tmp/workspace", { allowCompaction: true }),
    ).resolves.toMatchObject({ summary: "Recovered legacy context" });
    expect(agents[1][Symbol.asyncDispose]).toHaveBeenCalledOnce();
    expect(sdk.resumeAgent).toHaveBeenCalledTimes(2);
  });

  it("releases a closed registration even when SDK disposal rejects", async () => {
    const broken = fakeAgent("legacy-agent");
    vi.mocked(broken[Symbol.asyncDispose]).mockRejectedValue(new Error("disposal failed"));
    const sdk = fakeSdk({
      resumeAgent: vi
        .fn<CursorSdkFacade["resumeAgent"]>()
        .mockResolvedValueOnce(broken)
        .mockImplementation(async (id) => fakeAgent(id)),
    });
    const client = new CursorRuntimeClient(sdk, {
      workspaceDir: "/tmp/workspace",
      env: { [CURSOR_API_KEY_ENV]: "env-key" },
      store: new MemoryStore(),
    });
    const first = await client.resumeSession("legacy-agent", {});
    await expect(first.disconnect()).rejects.toThrow("disposal failed");
    const second = await client.resumeSession("legacy-agent", {});
    await second.disconnect();
    expect(sdk.resumeAgent).toHaveBeenCalledTimes(2);
  });

  it("cancels an orphaned active run before resuming an older agent", async () => {
    const store = new MemoryStore();
    const activeRun = fakeRun("run-orphan", "running");
    const sdk = fakeSdk({
      listRuns: vi.fn<CursorSdkFacade["listRuns"]>(async () => [activeRun]),
    });
    const client = new CursorRuntimeClient(sdk, {
      workspaceDir: "/tmp/workspace",
      env: {},
      store,
    });
    await client.login({ type: "api-key", apiKey: "cursor-test-key" });

    await client.resumeSession("agent-old", { workingDirectory: "/tmp/project" });

    expect(sdk.cancelRun).toHaveBeenCalledExactlyOnceWith("run-orphan", {
      runtime: "local",
      cwd: "/tmp/project",
    });
    expect(sdk.resumeAgent).toHaveBeenCalledWith("agent-old", expect.any(Object));
  });

  it("creates a local agent with the stored key and workspace cwd", async () => {
    const store = new MemoryStore();
    const sdk = fakeSdk();
    const client = new CursorRuntimeClient(sdk, {
      workspaceDir: "/tmp/workspace",
      env: {},
      store,
    });
    await client.login({ type: "api-key", apiKey: "cursor-test-key" });
    const session = await client.createSession({
      model: "composer-2.5",
      workingDirectory: "/tmp/project",
    });
    expect(session.sessionId).toBe("agent-1");
    expect(sdk.createAgent).toHaveBeenCalledWith({
      apiKey: "cursor-test-key",
      model: { id: "composer-2.5" },
      local: { cwd: "/tmp/project", settingSources: ["project"] },
    });
  });

  it("never passes Marshal instructions through Cursor's native system prompt", async () => {
    const store = new MemoryStore();
    const sdk = fakeSdk();
    const client = new CursorRuntimeClient(sdk, {
      workspaceDir: "/tmp/workspace",
      env: {},
      store,
    });
    await client.login({ type: "api-key", apiKey: "cursor-test-key" });
    const config = {
      model: "composer-2.5",
      workingDirectory: "/tmp/project",
      systemMessage: { content: "Marshal replacement instructions", mode: "replace" as const },
    };
    await client.createSession(config);
    await client.resumeSession("agent-old", config);

    expect(vi.mocked(sdk.createAgent).mock.calls[0]?.[0]).not.toHaveProperty("systemPrompt");
    expect(vi.mocked(sdk.resumeAgent).mock.calls[0]?.[1]).not.toHaveProperty("systemPrompt");
    expect(vi.mocked(sdk.createAgent).mock.calls[0]?.[0]).not.toHaveProperty("tools");
  });

  it("keeps append-mode instructions off the native replacement option", async () => {
    const store = new MemoryStore();
    const sdk = fakeSdk();
    const client = new CursorRuntimeClient(sdk, {
      workspaceDir: "/tmp/workspace",
      env: {},
      store,
    });
    await client.login({ type: "api-key", apiKey: "cursor-test-key" });

    await client.createSession({
      systemMessage: { content: "Legacy appended instructions", mode: "append" },
    });

    expect(vi.mocked(sdk.createAgent).mock.calls[0]?.[0]).not.toHaveProperty("systemPrompt");
  });

  it("omits tool guidance when the session intentionally disables every tool", async () => {
    const store = new MemoryStore();
    const sdk = fakeSdk();
    const client = new CursorRuntimeClient(sdk, {
      workspaceDir: "/tmp/workspace",
      env: {},
      store,
    });
    await client.login({ type: "api-key", apiKey: "cursor-test-key" });

    await client.createSession({
      availableTools: [],
      systemMessage: { content: "Tool-free replacement", mode: "replace" },
    });

    expect(sdk.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [],
      }),
    );
    expect(vi.mocked(sdk.createAgent).mock.calls[0]?.[0]).not.toHaveProperty("systemPrompt");
  });

  it("forwards normalized repository agents to Cursor", async () => {
    const store = new MemoryStore();
    const sdk = fakeSdk();
    const client = new CursorRuntimeClient(sdk, {
      workspaceDir: "/tmp/workspace",
      env: {},
      store,
    });
    await client.login({ type: "api-key", apiKey: "cursor-test-key" });
    await client.createSession({
      agents: {
        reviewer: { description: "Reviews changes", prompt: "Review carefully." },
      },
    });

    expect(sdk.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: {
          reviewer: {
            description: "Reviews changes",
            prompt: "Review carefully.",
            model: "inherit",
          },
        },
      }),
    );
  });

  it("starts a pending browser login that mints a stored API key", async () => {
    const store = new MemoryStore();
    const sdk = fakeSdk({
      login: vi.fn<CursorSdkFacade["login"]>(async (options) => {
        options?.onLoginUrl?.("https://cursor.com/login");
        return { apiKey: "minted-key", email: "user@example.com", apiKeyExpiresAtMs: 1 };
      }),
    });
    const client = new CursorRuntimeClient(sdk, {
      workspaceDir: "/tmp/workspace",
      env: {},
      store,
    });
    await expect(client.login({ type: "browser" })).resolves.toMatchObject({
      status: "pending",
      method: "browser",
      authorizationUrl: "https://cursor.com/login",
    });
    await vi.waitFor(async () => {
      await expect(client.getAuthStatus()).resolves.toMatchObject({
        isAuthenticated: true,
        login: "user@example.com",
      });
    });
  });

  it("passes host tools the Cursor agent id after create", async () => {
    const store = new MemoryStore();
    const sdk = fakeSdk();
    const client = new CursorRuntimeClient(sdk, {
      workspaceDir: "/tmp/workspace",
      env: {},
      store,
    });
    const handler = vi.fn<RuntimeTool["handler"]>(async () => "ok");
    await client.login({ type: "api-key", apiKey: "cursor-test-key" });
    await client.createSession({
      model: "composer-2.5",
      tools: [{ name: "workspace_info", handler }],
    });
    const created = vi.mocked(sdk.createAgent).mock.calls[0]?.[0];
    await expect(created?.local?.customTools?.workspace_info?.execute({}, {})).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect(handler).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ sessionId: "agent-1", toolName: "workspace_info" }),
    );
  });

  it("lists models with catalog reasoning levels", async () => {
    const store = new MemoryStore();
    const gptModelId = "gpt-5.4";
    const reasoningParamId = "reasoning";
    const sdk = fakeSdk({
      listModels: vi.fn<CursorSdkFacade["listModels"]>(async () => [
        {
          id: gptModelId,
          displayName: "GPT-5.4",
          parameters: [{ id: reasoningParamId, values: [{ value: "low" }, { value: "high" }] }],
        },
      ]),
    });
    const client = new CursorRuntimeClient(sdk, {
      workspaceDir: "/tmp/workspace",
      env: {},
      store,
    });
    await client.login({ type: "api-key", apiKey: "cursor-test-key" });
    await expect(client.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: gptModelId,
        supportedReasoningEfforts: ["low", "high"],
        capabilities: { supports: { reasoningEffort: true } },
      }),
    ]);
  });

  it("passes reasoning effort as model params when creating a session", async () => {
    const store = new MemoryStore();
    const modelId = "composer-2.5";
    const reasoningParamId = "reasoning";
    const reasoningEffort = "high" as const;
    const sdk = fakeSdk({
      listModels: vi.fn<CursorSdkFacade["listModels"]>(async () => [
        {
          id: modelId,
          displayName: "Composer 2.5",
          parameters: [
            { id: reasoningParamId, values: [{ value: "low" }, { value: reasoningEffort }] },
          ],
        },
      ]),
    });
    const client = new CursorRuntimeClient(sdk, {
      workspaceDir: "/tmp/workspace",
      env: {},
      store,
    });
    await client.login({ type: "api-key", apiKey: "cursor-test-key" });
    await client.createSession({
      model: modelId,
      reasoningEffort,
      workingDirectory: "/tmp/project",
    });
    expect(sdk.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: modelId, params: [{ id: reasoningParamId, value: reasoningEffort }] },
      }),
    );
  });
});
