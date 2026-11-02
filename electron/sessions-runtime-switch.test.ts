import * as fs from "fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionMetadata } from "../common/marshal-ipc-contract";
import type { IBackendProvider } from "./backend/types";
import type { PersistedSession } from "./session-store";
import { SessionTestAccess, testDouble } from "./testing/harness";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
vi.mock("fs", m.fsFactory);
vi.mock("./session-archive", m.sessionArchiveFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", m.skillsFactory);
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file");

function backend(
  runtimeId: string,
  authenticated = false,
  overrides: Partial<IBackendProvider> = {},
) {
  return testDouble<IBackendProvider>({
    runtimeId,
    origin: "copilot",
    isReady: vi.fn<() => boolean>(() => true),
    destroy: vi.fn<() => Promise<void>>(async () => {}),
    dispose: vi.fn<() => Promise<void>>(async () => {}),
    forceKill: vi.fn<() => Promise<void>>(async () => {}),
    checkAuthStatus: vi.fn<() => Promise<{ authenticated: boolean }>>(async () => ({
      authenticated,
    })),
    setInterceptFileChooser: vi.fn<IBackendProvider["setInterceptFileChooser"]>(),
    setCustomMcpServers: vi.fn<IBackendProvider["setCustomMcpServers"]>(),
    setTimezoneProvider: vi.fn<IBackendProvider["setTimezoneProvider"]>(),
    ...overrides,
  });
}

describe("SessionManager runtime switching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs).readFileSync.mockReturnValue("{}");
  });

  async function handoffFixture(
    exportState = vi.fn<
      () => Promise<import("../common/runtime-conversation-state").RuntimeConversationState>
    >(async () => ({
      version: 1 as const,
      sourceRuntimeId: "cursor",
      summary: "Latest summary after ten compactions.",
      messages: [
        {
          role: "user" as const,
          content:
            "<marshal-instructions>\nOld prompt\n</marshal-instructions>\n\n<user-request>\ncontinue the migration\n</user-request>",
        },
      ],
    })),
  ) {
    const { SessionManager } = await import("./sessions");
    const previous = backend("cursor", true, {
      sessions: testDouble({ exportConversationState: exportState }),
    });
    const manager = new SessionManager("/test/workspace", previous);
    const access = new SessionTestAccess(manager);
    let stored: PersistedSession = {
      id: "same-chat",
      name: "Migration",
      runtimeId: "cursor",
      backendOrigin: "copilot",
      backendId: "cursor-native-id",
      model: "composer-2.5",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [{ id: "old", role: "user", content: "Obsolete visible history", timestamp: "" }],
    };
    const metadata = { ...stored };
    vi.spyOn(access.store, "loadSessionData").mockImplementation(() => structuredClone(stored));
    vi.spyOn(access.store, "saveSessionData").mockImplementation((value) => {
      stored = structuredClone(value);
    });
    vi.spyOn(access.store, "loadIndex").mockReturnValue(
      testDouble({ sessions: [metadata], activeSessionId: stored.id }),
    );
    access.currentSessionId = stored.id;
    access.sessionHandles.set(stored.id, { sessionId: stored.id, backendId: stored.backendId });
    return { manager, access, previous, metadata, stored: () => stored, exportState };
  }

  it("opens a legacy foreign-runtime transcript without exporting or replacing its native session", async () => {
    const fixture = await handoffFixture();
    fixture.access.backend = backend("claude", true, {
      sessions: testDouble({
        exportConversationState: async () => {
          throw new Error("Source context unavailable");
        },
      }),
    });
    fixture.access.currentSessionId = null;
    fixture.access.sessionHandles.clear();
    const create = vi.fn<() => Promise<void>>(async () => {});
    fixture.access.setCreateBackendSessionForTest(create);
    vi.spyOn(fixture.access.store, "loadSessionHeader").mockImplementation(() =>
      testDouble({ ...fixture.stored(), messageCount: 1 }),
    );
    vi.spyOn(fixture.access.store, "loadSessionScope").mockImplementation(() => fixture.stored());
    vi.spyOn(fixture.access.store, "loadSessionMessagesTail").mockImplementation(async () => ({
      messages: fixture.stored().messages,
      hasMore: false,
      total: 1,
      oldestChunkIndex: 0,
    }));

    await expect(fixture.manager.getSessionScopeAsync("same-chat")).resolves.toBeNull();
    await expect(fixture.manager.switchSession("same-chat")).resolves.toMatchObject({
      kind: "loaded",
      session: { messages: [{ content: "Obsolete visible history" }] },
    });
    await expect(fixture.manager.getSessionScopeAsync("same-chat")).resolves.toMatchObject({
      id: "same-chat",
    });
    await expect(fixture.manager.getSessionMessagesPage("same-chat", 20)).resolves.toMatchObject({
      session: { messages: [{ content: "Obsolete visible history" }] },
    });
    expect(fixture.exportState).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(fixture.stored()).toMatchObject({ runtimeId: "cursor", backendId: "cursor-native-id" });

    const send = vi.fn<() => Promise<void>>(async () => {});
    fixture.access.setPerformSendForTest(send);
    await fixture.manager.sendMessage("same-chat", "continue");
    expect(send).toHaveBeenCalledOnce();
    expect(fixture.stored()).toMatchObject({
      runtimeId: "claude",
      pendingRuntimeHandoff: true,
      runtimeConversationState: {
        sourceRuntimeId: "cursor",
        messages: [{ role: "user", content: "Obsolete visible history" }],
      },
    });
    expect(fixture.stored().runtimeConversationState?.summary).toContain("reason: export-failed");
    expect(fixture.stored().messages).toHaveLength(1);
    expect(fixture.exportState).not.toHaveBeenCalled();
  });

  it("reads mobile history from another runtime without changing desktop selection or native context", async () => {
    const fixture = await handoffFixture();
    fixture.access.backend = backend("claude", true);
    fixture.access.currentSessionId = "desktop-chat";
    vi.spyOn(fixture.access.store, "loadSessionHeader").mockImplementation(() =>
      testDouble({ ...fixture.stored(), messageCount: 1 }),
    );
    vi.spyOn(fixture.access.store, "loadSessionMessagesTail").mockImplementation(async () => ({
      messages: fixture.stored().messages,
      hasMore: false,
      total: 1,
      oldestChunkIndex: 0,
    }));
    await expect(fixture.manager.getSessionAsync("same-chat")).resolves.toBeNull();
    await expect(
      fixture.manager.getSessionMessagesPage("same-chat", 20, true),
    ).resolves.toMatchObject({
      session: { messages: [{ content: "Obsolete visible history" }] },
      total: 1,
    });
    await expect(fixture.manager.getSessionForDisplay("same-chat")).resolves.toMatchObject({
      runtimeId: "cursor",
      backendId: "cursor-native-id",
    });
    expect(fixture.manager.getCurrentSessionId()).toBe("desktop-chat");
    expect(fixture.exportState).not.toHaveBeenCalled();
  });

  it("moves a default-account chat before its next send and leaves explicit accounts pinned", async () => {
    const fixture = await handoffFixture();
    fixture.access.selfToolDeps = testDouble({
      settingsManager: {
        get: () => ({
          runtimeAccounts: { cursor: { accounts: [{ id: "work" }], defaultAccountId: "work" } },
        }),
      },
    });
    vi.spyOn(fixture.access.store, "loadSessionHeader").mockImplementation(() =>
      testDouble({ ...fixture.stored(), messageCount: 1 }),
    );
    const switchModel = vi
      .spyOn(fixture.manager, "switchSessionModel")
      .mockResolvedValue("cursor@work:composer-2.5");
    const send = vi.fn<() => Promise<void>>(async () => {});
    fixture.access.setPerformSendForTest(send);
    await fixture.manager.sendMessage("same-chat", "continue");
    expect(switchModel).toHaveBeenCalledWith("same-chat", "cursor@work:composer-2.5", {
      accountSelection: "default",
    });
    expect(send).toHaveBeenCalledOnce();
    const pinned = fixture.stored();
    pinned.runtimeAccountSelection = "explicit";
    fixture.access.store.saveSessionData(pinned);
    switchModel.mockClear();
    await fixture.manager.sendMessage("same-chat", "next");
    expect(switchModel).not.toHaveBeenCalled();
  });

  it("sends on the current account and shows why when the new default account cannot start", async () => {
    const fixture = await handoffFixture();
    fixture.access.selfToolDeps = testDouble({
      settingsManager: {
        get: () => ({
          runtimeAccounts: { cursor: { accounts: [{ id: "work" }], defaultAccountId: "work" } },
        }),
      },
    });
    vi.spyOn(fixture.access.store, "loadSessionHeader").mockImplementation(() =>
      testDouble({ ...fixture.stored(), messageCount: 1 }),
    );
    vi.spyOn(fixture.manager, "switchSessionModel").mockRejectedValue(
      new Error("Couldn't switch this chat to Cursor (work): usage limit reached."),
    );
    const send = vi.fn<() => Promise<void>>(async () => {});
    fixture.access.setPerformSendForTest(send);
    await fixture.manager.sendMessage("same-chat", "continue");
    expect(send).toHaveBeenCalledOnce();
    expect(fixture.stored().messages.at(-1)).toMatchObject({
      role: "assistant",
      error: true,
      content: "Couldn't switch this chat to Cursor (work): usage limit reached.",
    });
  });

  it("creates new chats on the configured default and records explicit account overrides", async () => {
    const fixture = await handoffFixture();
    fixture.access.setCreateBackendSessionForTest(vi.fn<() => Promise<void>>(async () => {}));
    fixture.access.selfToolDeps = testDouble({
      settingsManager: {
        get: () => ({
          runtimeAccounts: { cursor: { accounts: [{ id: "work" }], defaultAccountId: "work" } },
        }),
      },
    });
    const followed = await fixture.manager.createSession("composer-2.5", undefined, {
      deferBackendStart: true,
      setActive: false,
    });
    expect(followed).toMatchObject({ model: "cursor@work:composer-2.5" });
    expect(fixture.stored().runtimeAccountSelection).toBe("default");
    const pinned = await fixture.manager.createSession("cursor@default:composer-2.5", undefined, {
      deferBackendStart: true,
      setActive: false,
    });
    expect(pinned).toMatchObject({ model: "cursor@default:composer-2.5" });
    expect(fixture.stored().runtimeAccountSelection).toBe("explicit");
  });

  it("stamps each lean decision on new sessions from its setting, env override, and default", async () => {
    const fixture = await handoffFixture();
    fixture.access.setCreateBackendSessionForTest(vi.fn<() => Promise<void>>(async () => {}));
    const createWith = async (
      experiments:
        | { leanPrompt?: boolean; leanRepoRules?: boolean; leanCore?: boolean }
        | undefined,
    ) => {
      fixture.access.selfToolDeps = testDouble({
        settingsManager: { get: () => ({ experiments }) },
      });
      await fixture.manager.createSession("composer-2.5", undefined, {
        deferBackendStart: true,
        setActive: false,
      });
      const stored = fixture.stored();
      return {
        leanPrompt: stored.leanPrompt,
        leanRepoRules: stored.leanRepoRules,
        leanCore: stored.leanCore,
      };
    };

    expect(await createWith(undefined)).toEqual({
      leanPrompt: true,
      leanRepoRules: true,
      leanCore: true,
    });
    expect(await createWith({ leanPrompt: false, leanRepoRules: true, leanCore: false })).toEqual({
      leanPrompt: false,
      leanRepoRules: true,
      leanCore: false,
    });
    process.env.MARSHAL_LEAN_PROMPT = "1";
    process.env.MARSHAL_LEAN_REPO_RULES = "1";
    process.env.MARSHAL_LEAN_CORE = "1";
    try {
      expect(
        await createWith({ leanPrompt: false, leanRepoRules: false, leanCore: false }),
      ).toEqual({ leanPrompt: true, leanRepoRules: true, leanCore: true });
    } finally {
      delete process.env.MARSHAL_LEAN_PROMPT;
      delete process.env.MARSHAL_LEAN_REPO_RULES;
      delete process.env.MARSHAL_LEAN_CORE;
    }
  });

  it("resolves agent runtime overrides without family routing and validates account conflicts", async () => {
    const fixture = await handoffFixture();
    const defaultModelForRuntime = vi.fn<() => Promise<string>>(async () => "opus");
    fixture.access.backend = backend("cursor", true, {
      sessions: testDouble({ defaultModelForRuntime }),
    });
    fixture.access.selfToolDeps = testDouble({
      settingsManager: {
        get: () => ({
          runtimeAccounts: { claude: { accounts: [{ id: "work" }], defaultAccountId: "work" } },
        }),
      },
    });
    await expect(fixture.manager.resolveAgentRuntimeModel("claude")).resolves.toBe("claude:opus");
    expect(defaultModelForRuntime).toHaveBeenCalledWith({ runtimeId: "claude", accountId: "work" });
    await expect(fixture.manager.resolveAgentRuntimeModel("claude@work", "sonnet")).resolves.toBe(
      "claude@work:sonnet",
    );
    await expect(fixture.manager.resolveAgentRuntimeModel("claude@default", "opus")).resolves.toBe(
      "claude@default:opus",
    );
    await expect(
      fixture.manager.resolveAgentRuntimeModel("claude@missing", "opus"),
    ).rejects.toThrow("not configured");
    await expect(fixture.manager.resolveAgentRuntimeModel("cursor", "claude:opus")).rejects.toThrow(
      "different execution targets",
    );
  });

  it("automatically exports an old Claude chat while continuing in Cursor", async () => {
    const fixture = await handoffFixture();
    const original = fixture.stored();
    original.runtimeId = "claude";
    original.backendId = "claude-original-id";
    delete original.runtimeConversationState;
    fixture.access.store.saveSessionData(original);
    fixture.metadata.runtimeId = "claude";
    const exported = {
      version: 1 as const,
      sourceRuntimeId: "claude",
      summary: "Native compacted Claude state",
      messages: [],
    };
    const exportSource = vi.fn<IBackendProvider["sessions"]["exportConversationState"]>(
      async () => exported,
    );
    fixture.access.backend = backend("cursor", true, {
      sessions: testDouble({ exportConversationState: exportSource }),
    });
    fixture.access.sessionHandles.clear();
    const send = vi.fn<() => Promise<void>>(async () => {});
    fixture.access.setPerformSendForTest(send);
    await fixture.manager.switchSession("same-chat");
    expect(exportSource).not.toHaveBeenCalled();
    await fixture.manager.sendMessage("same-chat", "pick up here");
    expect(exportSource).toHaveBeenCalledWith(
      "same-chat",
      {
        runtimeId: "claude",
        accountId: undefined,
        backendId: "claude-original-id",
        workingDirectory: "/test/workspace",
      },
      { allowCompaction: true },
    );
    expect(fixture.stored()).toMatchObject({
      runtimeId: "cursor",
      runtimeConversationState: exported,
      pendingRuntimeHandoff: true,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("transfers a saved checkpoint only when the selected foreign chat is continued", async () => {
    const fixture = await handoffFixture();
    const original = fixture.stored();
    original.runtimeConversationState = await fixture.exportState();
    fixture.access.store.saveSessionData(original);
    fixture.exportState.mockClear();
    fixture.access.backend = backend("claude", true);
    fixture.access.sessionHandles.clear();
    fixture.access.currentSessionId = null;
    const send = vi.fn<() => Promise<void>>(async () => {});
    fixture.access.setPerformSendForTest(send);
    await fixture.manager.switchSession("same-chat");
    expect(fixture.stored().runtimeId).toBe("cursor");
    await fixture.manager.sendMessage("same-chat", "continue");
    expect(send).toHaveBeenCalledOnce();
    expect(fixture.stored()).toMatchObject({ runtimeId: "claude", pendingRuntimeHandoff: true });
    expect(fixture.stored().backendId).toBeUndefined();
    expect(fixture.exportState).not.toHaveBeenCalled();
  });

  it("switches runtimes without exporting or migrating the selected chat", async () => {
    const fixture = await handoffFixture();
    const original = fixture.stored();
    await fixture.manager.switchBackend(backend("claude", true));
    expect(fixture.exportState).not.toHaveBeenCalled();
    expect(fixture.manager.getCurrentSessionId()).toBe("same-chat");
    expect(fixture.stored()).toEqual(original);
    expect(fixture.metadata.runtimeId).toBe("cursor");
    await fixture.manager.switchBackend(backend("cursor", true));
    expect(fixture.stored()).toEqual(original);
    expect(fixture.exportState).not.toHaveBeenCalled();
  });

  it("does not wait for unavailable legacy context while switching runtimes", async () => {
    const fixture = await handoffFixture(vi.fn(() => new Promise<never>(() => {})));
    await fixture.manager.switchBackend(backend("claude", true));
    expect(fixture.exportState).not.toHaveBeenCalled();
    expect(fixture.previous.destroy).toHaveBeenCalledOnce();
    expect(fixture.stored()).toMatchObject({
      runtimeId: "cursor",
      backendId: "cursor-native-id",
      model: "composer-2.5",
    });
    expect(fixture.manager.getCurrentSessionId()).toBe("same-chat");
  });

  it("exports context only when the selected chat is continued in the new runtime", async () => {
    const fixture = await handoffFixture();
    const exported = await fixture.exportState();
    fixture.exportState.mockClear();
    const exportSource = vi.fn<IBackendProvider["sessions"]["exportConversationState"]>(
      async () => exported,
    );
    await fixture.manager.switchBackend(
      backend("claude", true, {
        sessions: testDouble({ exportConversationState: exportSource }),
      }),
    );
    expect(exportSource).not.toHaveBeenCalled();
    expect(fixture.exportState).not.toHaveBeenCalled();
    const send = vi.fn<() => Promise<void>>(async () => {});
    fixture.access.setPerformSendForTest(send);
    await fixture.manager.sendMessage("same-chat", "continue");
    expect(exportSource).toHaveBeenCalledWith(
      "same-chat",
      {
        runtimeId: "cursor",
        accountId: undefined,
        backendId: "cursor-native-id",
        workingDirectory: "/test/workspace",
      },
      { allowCompaction: true },
    );
    expect(send).toHaveBeenCalledOnce();
    expect(fixture.stored()).toMatchObject({
      runtimeId: "claude",
      pendingRuntimeHandoff: true,
      runtimeConversationState: {
        sourceRuntimeId: "cursor",
        summary: "Latest summary after ten compactions.",
        messages: [{ role: "user", content: "continue the migration" }],
      },
    });
    expect(fixture.stored().backendId).toBeUndefined();
    expect(fixture.stored().messages[0].content).toBe("Obsolete visible history");
  });

  it("rejects a busy chat handoff before exporting context", async () => {
    const fixture = await handoffFixture();
    vi.spyOn(fixture.manager, "isSessionBusy").mockReturnValue(true);
    await expect(fixture.manager.prepareRuntimeHandoff("same-chat")).rejects.toThrow(
      "response to finish",
    );
    expect(fixture.exportState).not.toHaveBeenCalled();
    expect(fixture.previous.destroy).not.toHaveBeenCalled();
  });

  it("resumes a cold source before a cross-runtime model change and then recreates the target", async () => {
    const fixture = await handoffFixture();
    fixture.access.sessionHandles.clear();
    const disconnect = vi.fn<(sessionId: string) => Promise<void>>(async () => {});
    const destroy = vi.fn<(sessionId: string) => Promise<void>>(async () => {});
    Object.assign(fixture.previous.sessions, { disconnect, destroy });
    const starts: Array<{ isNew: boolean; model: string | undefined }> = [];
    fixture.access.setCreateBackendSessionForTest(async (sessionId, isNew, model) => {
      starts.push({ isNew: isNew === true, model });
      fixture.access.sessionHandles.set(sessionId, {
        sessionId,
        backendId: isNew ? "target-native" : "cursor-native-id",
      });
    });
    await expect(
      fixture.manager.switchSessionModel("same-chat", "claude:claude-sonnet-4-5"),
    ).resolves.toBe("claude:claude-sonnet-4-5");
    expect(starts).toEqual([
      { isNew: false, model: "composer-2.5" },
      { isNew: true, model: "claude:claude-sonnet-4-5" },
    ]);
    expect(disconnect).toHaveBeenCalledWith("same-chat");
    expect(destroy).not.toHaveBeenCalled();
    expect(fixture.stored()).toMatchObject({
      id: "same-chat",
      runtimeId: "cursor",
      model: "claude:claude-sonnet-4-5",
      pendingRuntimeHandoff: true,
    });
  });

  it("restores the source model and native ID when the destination cannot start", async () => {
    const fixture = await handoffFixture();
    Object.assign(fixture.previous.sessions, {
      disconnect: vi.fn<(sessionId: string) => Promise<void>>(async () => {}),
    });
    fixture.access.setCreateBackendSessionForTest(async () => {
      throw new Error("destination unavailable");
    });
    await expect(
      fixture.manager.switchSessionModel("same-chat", "claude:claude-sonnet-4-5"),
    ).rejects.toThrow("destination unavailable");
    expect(fixture.stored()).toMatchObject({
      runtimeId: "cursor",
      model: "composer-2.5",
      backendId: "cursor-native-id",
    });
    expect(fixture.stored().pendingRuntimeHandoff).not.toBe(true);
    expect(fixture.metadata.backendId).toBe("cursor-native-id");
    expect(fixture.access.sessionHandles.has("same-chat")).toBe(false);
  });

  type ExportResult =
    | import("../common/runtime-conversation-state").RuntimeConversationState
    | null;

  function trackStarts(fixture: Awaited<ReturnType<typeof handoffFixture>>) {
    const starts: Array<{ isNew: boolean; model: string | undefined }> = [];
    Object.assign(fixture.previous.sessions, {
      disconnect: vi.fn<(sessionId: string) => Promise<void>>(async () => {}),
    });
    fixture.access.setCreateBackendSessionForTest(async (sessionId, isNew, model) => {
      starts.push({ isNew: isNew === true, model });
      fixture.access.sessionHandles.set(sessionId, {
        sessionId,
        backendId: isNew ? `native-${starts.length}` : "cursor-native-id",
      });
    });
    vi.spyOn(fixture.access.store, "loadSessionHeader").mockImplementation(() =>
      testDouble({ ...fixture.stored(), messageCount: fixture.stored().messages.length }),
    );
    return starts;
  }

  it.each<[string, string, () => Promise<ExportResult>, string]>([
    [
      "Codex's encrypted compaction",
      "codex:gpt-5.5",
      async () => {
        throw new Error("Codex's retained compaction state is encrypted and cannot be exported.");
      },
      "export-failed",
    ],
    [
      "a Cursor chat without a checkpoint",
      "composer-2.5",
      async () => {
        throw new Error("Cursor did not expose a readable compaction checkpoint.");
      },
      "export-failed",
    ],
    ["no retained context", "composer-2.5", async () => null, "export-unavailable"],
    [
      "an empty export",
      "composer-2.5",
      async () => ({ version: 1, sourceRuntimeId: "cursor", messages: [] }),
      "empty-export",
    ],
    [
      "another runtime's checkpoint",
      "composer-2.5",
      async () => ({ version: 1, sourceRuntimeId: "gateway", summary: "foreign", messages: [] }),
      "runtime-mismatch",
    ],
  ])(
    "switches models when the source offers %s by rebuilding from the transcript",
    async (_label, sourceModel, exportImpl, reason) => {
      const fixture = await handoffFixture();
      const original = fixture.stored();
      original.model = sourceModel;
      fixture.access.store.saveSessionData(original);
      const exportState = vi.fn<() => Promise<ExportResult>>(exportImpl);
      Object.assign(fixture.previous.sessions, { exportConversationState: exportState });
      const starts = trackStarts(fixture);
      await expect(
        fixture.manager.switchSessionModel("same-chat", "claude:claude-sonnet-4-5"),
      ).resolves.toBe("claude:claude-sonnet-4-5");
      expect(exportState).toHaveBeenCalledOnce();
      expect(starts).toEqual([{ isNew: true, model: "claude:claude-sonnet-4-5" }]);
      const stored = fixture.stored();
      expect(stored).toMatchObject({
        model: "claude:claude-sonnet-4-5",
        pendingRuntimeHandoff: true,
        runtimeConversationState: {
          sourceRuntimeId: sourceModel.startsWith("codex:") ? "codex" : "cursor",
          messages: [{ role: "user", content: "Obsolete visible history" }],
        },
      });
      expect(stored.runtimeConversationState?.summary).toContain(`reason: ${reason}`);
      expect(stored.runtimeConversationState?.summary).not.toContain("Obsolete visible history");
    },
  );

  it("rebuilds from the transcript when the chat has no native session ID", async () => {
    const fixture = await handoffFixture();
    const original = fixture.stored();
    delete original.backendId;
    fixture.access.store.saveSessionData(original);
    fixture.access.sessionHandles.clear();
    const starts = trackStarts(fixture);
    await fixture.manager.switchSessionModel("same-chat", "codex:gpt-5.5");
    expect(fixture.exportState).not.toHaveBeenCalled();
    expect(starts).toEqual([]);
    expect(fixture.stored()).toMatchObject({ model: "codex:gpt-5.5", pendingRuntimeHandoff: true });
    expect(fixture.stored().runtimeConversationState?.summary).toContain(
      "reason: missing-native-id",
    );
  });

  it("moves a chat on another account to the default account when the picker sends a plain model", async () => {
    const fixture = await handoffFixture();
    fixture.access.selfToolDeps = testDouble({
      settingsManager: {
        get: () => ({
          runtimeAccounts: {
            cursor: { accounts: [{ id: "work" }, { id: "home" }], defaultAccountId: "work" },
          },
        }),
      },
    });
    const original = fixture.stored();
    original.model = "cursor@home:composer-2.5";
    original.runtimeAccountSelection = "explicit";
    delete original.backendId;
    fixture.access.store.saveSessionData(original);
    fixture.access.sessionHandles.clear();

    await fixture.manager.switchSessionModel("same-chat", "composer-2.5");
    expect(fixture.stored().model).toBe("cursor@home:composer-2.5");

    await fixture.manager.setSessionModel("same-chat", "composer-2.5");
    expect(fixture.stored()).toMatchObject({
      model: "cursor@work:composer-2.5",
      runtimeAccountSelection: "default",
    });
  });

  it("defers a model change while responding, keeps steering on the running turn, and applies it before the next send", async () => {
    const fixture = await handoffFixture();
    const starts = trackStarts(fixture);
    const order: string[] = [];
    fixture.access.setPerformSendForTest(async () => {
      order.push(`send:${fixture.stored().model}`);
    });
    fixture.access.busyTracker.setBusy("same-chat");
    await expect(
      fixture.manager.switchSessionModel("same-chat", "claude:claude-sonnet-4-5"),
    ).resolves.toBe("claude:claude-sonnet-4-5");
    expect(fixture.stored().model).toBe("composer-2.5");
    expect(fixture.stored().pendingModelSwitch).toMatchObject({
      model: "claude:claude-sonnet-4-5",
    });
    expect(fixture.manager.getSessionModel("same-chat")).toBe("claude:claude-sonnet-4-5");
    expect(fixture.exportState).not.toHaveBeenCalled();

    await fixture.manager.sendMessage("same-chat", "also check the tests", undefined, {
      busySteer: true,
    });
    expect(order).toEqual(["send:composer-2.5"]);
    expect(starts).toEqual([]);
    expect(fixture.stored().pendingModelSwitch).toBeDefined();

    fixture.access.busyTracker.setIdle("same-chat");
    await fixture.manager.sendMessage("same-chat", "next step");
    expect(starts).toEqual([{ isNew: true, model: "claude:claude-sonnet-4-5" }]);
    expect(order).toEqual(["send:composer-2.5", "send:claude:claude-sonnet-4-5"]);
    expect(fixture.stored().pendingModelSwitch).toBeUndefined();
    expect(fixture.manager.getSessionModel("same-chat")).toBe("claude:claude-sonnet-4-5");
  });

  it("applies a deferred model change when the running turn goes idle", async () => {
    const fixture = await handoffFixture();
    const starts = trackStarts(fixture);
    let listener: ((event: import("./backend/types").BackendEvent) => void) | undefined;
    Object.assign(fixture.previous.sessions, {
      subscribe: vi.fn<(sessionId: string, next: typeof listener) => () => void>(
        (_sessionId, next) => {
          listener = next;
          return () => {};
        },
      ),
    });
    fixture.access.subscribeToBackendEvents("same-chat");
    fixture.access.busyTracker.setBusy("same-chat");
    await fixture.manager.switchSessionModel("same-chat", "codex:gpt-5.5");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(starts).toEqual([]);
    listener?.({ type: "idle" });
    await vi.waitFor(() => expect(fixture.stored().model).toBe("codex:gpt-5.5"));
    expect(starts).toEqual([{ isNew: true, model: "codex:gpt-5.5" }]);
    expect(fixture.stored().pendingModelSwitch).toBeUndefined();
  });

  it("keeps the chat usable on its runtime and shows why a deferred switch failed", async () => {
    const fixture = await handoffFixture();
    const starts = trackStarts(fixture);
    fixture.access.setCreateBackendSessionForTest(async (sessionId, isNew, model) => {
      starts.push({ isNew: isNew === true, model });
      if (isNew) throw new Error("Codex is not signed in.");
      fixture.access.sessionHandles.set(sessionId, { sessionId, backendId: "cursor-native-id" });
    });
    const send = vi.fn<() => Promise<void>>(async () => {});
    fixture.access.setPerformSendForTest(send);
    fixture.access.busyTracker.setBusy("same-chat");
    await fixture.manager.switchSessionModel("same-chat", "codex:gpt-5.5");
    fixture.access.busyTracker.setIdle("same-chat");

    await fixture.manager.sendMessage("same-chat", "keep going");
    expect(send).toHaveBeenCalledOnce();
    const stored = fixture.stored();
    expect(stored).toMatchObject({ model: "composer-2.5", backendId: "cursor-native-id" });
    expect(stored.pendingModelSwitch).toBeUndefined();
    expect(stored.pendingRuntimeHandoff).not.toBe(true);
    expect(fixture.access.getSdkSessionId("same-chat")).toBe("cursor-native-id");
    expect(fixture.access.sessionHandles.has("same-chat")).toBe(false);
    const notice = stored.messages.at(-1);
    expect(notice).toMatchObject({ role: "assistant", error: true });
    expect(notice?.content).toContain("Couldn't switch this chat to Codex");
    expect(notice?.content).toContain("The chat stays on Cursor.");
    expect(notice?.content).toContain("Codex isn't signed in. Sign in under Settings");
    expect(fixture.manager.getSessionModel("same-chat")).toBe("composer-2.5");

    fixture.access.setCreateBackendSessionForTest(async (sessionId, isNew, model) => {
      starts.push({ isNew: isNew === true, model });
      fixture.access.sessionHandles.set(sessionId, { sessionId, backendId: "native-retry" });
    });
    await expect(fixture.manager.switchSessionModel("same-chat", "codex:gpt-5.5")).resolves.toBe(
      "codex:gpt-5.5",
    );
    expect(fixture.stored().model).toBe("codex:gpt-5.5");
  });

  it("explains a failed direct switch and leaves the chat on its runtime", async () => {
    const fixture = await handoffFixture();
    trackStarts(fixture);
    fixture.access.setCreateBackendSessionForTest(async (_sessionId, isNew) => {
      if (isNew) throw new Error('Model "gpt-9" is not available in the codex runtime.');
    });
    await expect(fixture.manager.switchSessionModel("same-chat", "codex:gpt-9")).rejects.toThrow(
      "Pick a model from Codex's list",
    );
    expect(fixture.stored()).toMatchObject({
      model: "composer-2.5",
      backendId: "cursor-native-id",
    });
  });

  it.each<[string, () => Promise<ExportResult>]>([
    [
      "an encrypted Codex export",
      async () => {
        throw new Error("Codex's retained compaction state is encrypted and cannot be exported.");
      },
    ],
    [
      "a Codex export that predates its latest turns",
      async () => ({
        version: 1,
        sourceRuntimeId: "codex",
        messages: [
          { role: "user", content: "plan the schema" },
          { role: "assistant", content: "planned on claude" },
        ],
      }),
    ],
  ])("carries Codex turns back when a chat returns to Claude after %s", async (_label, codex) => {
    const fixture = await handoffFixture();
    const original = fixture.stored();
    original.model = "claude:claude-sonnet-4-5";
    original.messages = [
      { id: "u1", role: "user", content: "plan the schema", timestamp: "" },
      { id: "a1", role: "assistant", content: "planned on claude", timestamp: "" },
    ];
    fixture.access.store.saveSessionData(original);
    const starts = trackStarts(fixture);
    const exportState = vi.fn<() => Promise<ExportResult>>(async () => ({
      version: 1,
      sourceRuntimeId: "claude",
      messages: [
        { role: "user", content: "plan the schema" },
        { role: "assistant", content: "planned on claude" },
      ],
    }));
    Object.assign(fixture.previous.sessions, { exportConversationState: exportState });

    await fixture.manager.switchSessionModel("same-chat", "codex:gpt-5.5");
    const onCodex = fixture.stored();
    expect(onCodex.backendId).toBeUndefined();
    onCodex.backendId = "codex-native";
    onCodex.pendingRuntimeHandoff = false;
    onCodex.messages.push(
      { id: "u2", role: "user", content: "build it", timestamp: "" },
      { id: "a2", role: "assistant", content: "built on codex", timestamp: "" },
    );
    fixture.access.store.saveSessionData(onCodex);
    exportState.mockImplementation(codex);

    await fixture.manager.switchSessionModel("same-chat", "claude:claude-sonnet-4-5");
    expect(starts).toEqual([
      { isNew: true, model: "codex:gpt-5.5" },
      { isNew: true, model: "claude:claude-sonnet-4-5" },
    ]);
    const back = fixture.stored();
    expect(back).toMatchObject({ model: "claude:claude-sonnet-4-5", pendingRuntimeHandoff: true });
    expect(back.runtimeConversationState?.sourceRuntimeId).toBe("codex");
    expect(back.runtimeConversationState?.messages.map((entry) => entry.content)).toEqual([
      "plan the schema",
      "planned on claude",
      "build it",
      "built on codex",
    ]);
  });

  it("adds turns a saved checkpoint missed when another runtime continues the chat", async () => {
    const fixture = await handoffFixture();
    const original = fixture.stored();
    original.runtimeConversationState = {
      version: 1,
      sourceRuntimeId: "cursor",
      summary: "Older work",
      messages: [{ role: "user", content: "Obsolete visible history" }],
    };
    original.messages.push(
      { id: "a", role: "assistant", content: "done", timestamp: "" },
      { id: "u", role: "user", content: "one more change", timestamp: "" },
      { id: "b", role: "assistant", content: "changed", timestamp: "" },
    );
    fixture.access.store.saveSessionData(original);
    fixture.access.backend = backend("claude", true);
    fixture.access.sessionHandles.clear();
    fixture.access.setPerformSendForTest(vi.fn<() => Promise<void>>(async () => {}));
    await fixture.manager.sendMessage("same-chat", "continue");
    expect(fixture.stored().runtimeConversationState).toMatchObject({
      summary: "Older work",
      messages: [
        { role: "user", content: "Obsolete visible history" },
        { role: "user", content: "one more change" },
        { role: "assistant", content: "changed" },
      ],
    });
  });

  it("replaces the backend and tears down the previous runtime", async () => {
    const { SessionManager } = await import("./sessions");
    const previous = backend("copilot");
    const next = backend("codex", true);
    const manager = new SessionManager("/test/workspace", previous);

    await manager.switchBackend(next);

    expect(previous.destroy).toHaveBeenCalledOnce();
    expect(previous.dispose).toHaveBeenCalledOnce();
    expect(next.setInterceptFileChooser).toHaveBeenCalledWith(false);
    expect(next.setCustomMcpServers).toHaveBeenCalledWith([]);
    await expect(manager.checkAuthStatus()).resolves.toMatchObject({ isAuthenticated: true });
  });

  it("disposes an unused candidate for the already-active runtime", async () => {
    const { SessionManager } = await import("./sessions");
    const current = backend("copilot");
    const duplicate = backend("copilot");
    const manager = new SessionManager("/test/workspace", current);

    await manager.switchBackend(duplicate);

    expect(current.destroy).not.toHaveBeenCalled();
    expect(duplicate.dispose).toHaveBeenCalledOnce();
  });

  it("interrupts passive response collectors during replacement", async () => {
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", backend("copilot"));
    const collecting = manager.collectNextAssistantReply("session-1", 60_000);

    await manager.switchBackend(backend("claude"));

    await expect(collecting).rejects.toThrow("runtime switch");
  });

  it("ignores an old runtime login completion after replacement", async () => {
    const { SessionManager } = await import("./sessions");
    let resolveLogin!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveLogin = resolve;
    });
    const previous = backend("copilot", false, {
      login: vi.fn<IBackendProvider["login"]>(async () => ({ completion })),
    });
    const next = backend("codex", true);
    const manager = new SessionManager("/test/workspace", previous);

    await manager.login();
    await manager.switchBackend(next);
    resolveLogin();
    await completion;
    await Promise.resolve();

    expect(next.checkAuthStatus).not.toHaveBeenCalled();
  });

  it("pauses pursuing goals owned by the previous runtime", async () => {
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", backend("copilot"));
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadIndex").mockReturnValue(
      testDouble<ReturnType<typeof access.store.loadIndex>>({
        sessions: [{ id: "goal-session", runtimeId: "copilot" }],
      }),
    );
    type GoalIntegration = Parameters<typeof manager.setGoalIntegration>[0];
    const pauseGoal = vi.fn<(sessionId: string) => void>();
    const pauseEngine = vi.fn<(sessionId: string) => void>();
    manager.setGoalIntegration(
      testDouble<GoalIntegration>({
        getGoal: () =>
          testDouble<NonNullable<ReturnType<GoalIntegration["getGoal"]>>>({
            status: "pursuing",
          }),
        captureFence: () => null,
        pause: pauseGoal,
      }),
      testDouble<Parameters<typeof manager.setGoalIntegration>[1]>({
        pause: pauseEngine,
      }),
    );

    await manager.switchBackend(backend("claude"));

    expect(pauseGoal).toHaveBeenCalledWith("goal-session");
    expect(pauseEngine).toHaveBeenCalledWith("goal-session");
  });

  it("waits for an old runtime sign-out before replacing it", async () => {
    const { SessionManager } = await import("./sessions");
    let finishSignOut!: () => void;
    const signOutDone = new Promise<void>((resolve) => {
      finishSignOut = resolve;
    });
    const previous = backend("copilot", false, {
      signOut: vi.fn<IBackendProvider["signOut"]>(() => signOutDone),
    });
    const next = backend("codex", true);
    const manager = new SessionManager("/test/workspace", previous);

    const signingOut = manager.signOut();
    const switching = manager.switchBackend(next);
    expect(next.setTimezoneProvider).not.toHaveBeenCalled();

    finishSignOut();
    await Promise.all([signingOut, switching]);

    await expect(manager.checkAuthStatus()).resolves.toMatchObject({ isAuthenticated: true });
  });

  it("retries deferred metadata creation on the runtime selected during an in-flight switch", async () => {
    const { SessionManager } = await import("./sessions");
    const previous = backend("copilot");
    const next = backend("codex", true);
    const manager = new SessionManager("/test/workspace", previous);
    const access = new SessionTestAccess(manager);
    const persisted = new Map<string, PersistedSession>();
    const index = { sessions: [] as SessionMetadata[], activeSessionId: null as string | null };
    vi.spyOn(access.store, "loadIndex").mockReturnValue(index);
    vi.spyOn(access.store, "loadSessionData").mockImplementation(
      (sessionId) => persisted.get(sessionId) ?? null,
    );
    vi.spyOn(access.store, "saveSessionData").mockImplementation((session) => {
      persisted.set(session.id, session);
    });
    vi.spyOn(access.store, "deleteSessionData").mockImplementation((sessionId) => {
      persisted.delete(sessionId);
    });
    let releaseFirstIndex!: () => void;
    const firstIndexGate = new Promise<void>((resolve) => {
      releaseFirstIndex = resolve;
    });
    let indexMutations = 0;
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (fn) => {
      indexMutations += 1;
      if (indexMutations === 1) await firstIndexGate;
      return fn(index);
    });
    access.replaceCreateBackendSession(async (sessionId) => {
      access.sessionHandles.set(sessionId, {
        sessionId,
        backendId: `backend-${sessionId}`,
      });
    });

    const creating = manager.createInteractiveSession("gpt-5", "default", { source: "user" });
    await vi.waitFor(() => expect(indexMutations).toBe(1));
    await manager.switchBackend(next);
    releaseFirstIndex();

    const created = await creating;

    expect(created.runtimeId).toBe("codex");
    expect(index.sessions).toEqual([
      expect.objectContaining({ id: created.id, runtimeId: "codex" }),
    ]);
    expect([...persisted.values()]).toEqual([
      expect.objectContaining({ id: created.id, runtimeId: "codex" }),
    ]);
  });
});
