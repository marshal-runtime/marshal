import * as fs from "fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SessionInternalControlMetadata,
  SessionViewEvent,
  TurnEvent,
} from "../common/marshal-ipc-contract";
import type { BackendEvent, IBackendProvider } from "./backend/types";
import * as safeStorage from "./safe-storage-file";
import { SessionTestAccess, createTestBackend } from "./testing/harness";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
vi.mock("fs", m.fsFactory);
vi.mock("./session-archive", m.sessionArchiveFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", m.skillsFactory);
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file", () => ({
  readEncryptedFileSync: vi.fn<(path: string) => string>(),
  writeEncryptedFileSync: vi.fn<(path: string, content: string) => void>(),
  readEncryptedFile: vi.fn<(path: string) => Promise<string>>(),
  writeEncryptedFile: vi.fn<(path: string, content: string) => Promise<void>>(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  const files = new Map<string, string>();
  const read = (path: string) => {
    const content = files.get(path);
    if (content === undefined) throw new Error(`Missing test file: ${path}`);
    return content;
  };
  vi.mocked(fs.existsSync).mockImplementation((path) => files.has(String(path)));
  vi.mocked(fs.readdirSync).mockReturnValue([]);
  vi.mocked(fs.readFileSync).mockImplementation((path) => read(String(path)));
  vi.mocked(fs.writeFileSync).mockImplementation((path, content) => {
    if (typeof content !== "string") throw new Error("Expected a text file write");
    files.set(String(path), content);
  });
  vi.mocked(safeStorage.readEncryptedFileSync).mockImplementation(read);
  vi.mocked(safeStorage.readEncryptedFile).mockImplementation(async (path) => read(path));
  vi.mocked(safeStorage.writeEncryptedFileSync).mockImplementation((path, content) => {
    files.set(path, content);
  });
  vi.mocked(safeStorage.writeEncryptedFile).mockImplementation(async (path, content) => {
    files.set(path, content);
  });
});

async function setupTurn() {
  const { SessionManager } = await import("./sessions");
  const backend: IBackendProvider = await createTestBackend();
  const manager = new SessionManager("/test/workspace", backend);
  const access = new SessionTestAccess(manager);
  const sessionId = "interrupted-session";
  access.store.saveSessionData({
    id: sessionId,
    name: "Interrupted turn",
    backendOrigin: "copilot",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hasUnread: false,
    isActive: true,
    messages: [],
  });
  access.sessionHandles.set(sessionId, { sessionId, backendId: "sdk-interrupted" });
  access.subscribeToBackendEvents(sessionId);
  const dispatch = [...access.getCopilotBackendSessionSubscribers(sessionId)][0];
  if (!dispatch) throw new Error("Expected backend subscriber");
  access.busyTracker.setBusy(sessionId);
  vi.spyOn(backend.sessions, "abort").mockResolvedValue({});
  const views: SessionViewEvent[] = [];
  const events: TurnEvent[] = [];
  manager.addViewEventListener((_id, event) => views.push(event));
  manager.addEventListener((_id, event) => events.push(event));
  const committed = () => views.flatMap((view) => view.committedMessages);
  const reload = () => access.store.loadSessionData(sessionId)?.messages;
  return { manager, access, backend, sessionId, dispatch, views, events, committed, reload };
}

const partialActivity: BackendEvent[] = [
  { type: "reasoning-delta", text: "Inspect the failing path." },
  { type: "text-delta", text: "I found the relevant code.", messageId: "commentary" },
  { type: "tool-start", toolCallId: "read", toolName: "read_file", args: { path: "app.ts" } },
  { type: "tool-result", toolCallId: "read", success: true, result: "File contents" },
  { type: "reasoning-delta", text: "Now check the caller." },
  { type: "tool-start", toolCallId: "search", toolName: "grep", args: { pattern: "caller" } },
];

function dispatchAtCheckpointIntervals(
  dispatch: (event: BackendEvent) => void,
  events: readonly BackendEvent[],
): void {
  let now = Date.now();
  const nowSpy = vi.spyOn(Date, "now");
  try {
    for (const event of events) {
      now += 30_000;
      nowSpy.mockReturnValue(now);
      dispatch(event);
    }
  } finally {
    nowSpy.mockRestore();
  }
}

describe("Interrupted turn transcript", () => {
  it("checkpoints streamed activity before the turn ends", async () => {
    const { access, sessionId, dispatch, reload } = await setupTurn();
    dispatchAtCheckpointIntervals(dispatch, partialActivity);

    expect(reload()).toEqual([]);
    expect(access.store.loadSessionData(sessionId)?.liveTurnCheckpoint).toMatchObject({
      version: 1,
      message: {
        role: "assistant",
        content: "I found the relevant code.",
        reasoning: { text: "Inspect the failing path.Now check the caller." },
      },
    });
  });

  it("persists live output at most once every 30 seconds per session", async () => {
    const { access, sessionId, dispatch } = await setupTurn();
    const save = vi.spyOn(access.store, "saveSessionData");
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    dispatch({ type: "text-delta", text: "First." });
    dispatch({ type: "text-delta", text: "Second." });
    now += 29_999;
    nowSpy.mockReturnValue(now);
    dispatch({ type: "text-delta", text: "Third." });
    expect(save).toHaveBeenCalledTimes(1);

    now += 1;
    nowSpy.mockReturnValue(now);
    dispatch({ type: "text-delta", text: "Fourth." });
    expect(save).toHaveBeenCalledTimes(2);
    expect(access.store.loadSessionData(sessionId)?.liveTurnCheckpoint?.message.content).toBe(
      "First.Second.Third.Fourth.",
    );
    nowSpy.mockRestore();
  });

  it("recovers a previous process checkpoint even when the resumed backend is busy", async () => {
    const first = await setupTurn();
    dispatchAtCheckpointIntervals(first.dispatch, partialActivity.slice(0, -1));

    const { SessionManager } = await import("./sessions");
    const restarted = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(restarted);
    access.busyTracker.setBusy(first.sessionId);

    const page = await restarted.getSessionMessagesPage(first.sessionId, 20);

    expect(page?.session.messages).toMatchObject([
      {
        content: "I found the relevant code.",
        reasoning: { text: "Inspect the failing path.Now check the caller." },
      },
    ]);
    expect(page?.session.liveTurnCheckpoint).toBeUndefined();
  });

  it("promotes a stale checkpoint before saving new resumed-stream output", async () => {
    const first = await setupTurn();
    first.dispatch({ type: "text-delta", text: "Before restart." });

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const restarted = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(restarted);
    access.sessionHandles.set(first.sessionId, {
      sessionId: first.sessionId,
      backendId: "sdk-interrupted",
    });
    access.subscribeToBackendEvents(first.sessionId);
    const dispatch = [...access.getCopilotBackendSessionSubscribers(first.sessionId)][0];
    if (!dispatch) throw new Error("Expected restarted backend subscriber");
    access.busyTracker.setBusy(first.sessionId);

    dispatch({ type: "text-delta", text: "After restart." });

    const stored = access.store.loadSessionData(first.sessionId);
    expect(stored?.messages).toEqual([expect.objectContaining({ content: "Before restart." })]);
    expect(stored?.liveTurnCheckpoint?.message.content).toBe("After restart.");
  });

  it.each(["cancel", "steer"] as const)(
    "keeps reasoning, commentary, and tools visible and reloadable after %s",
    async (action) => {
      const turn = await setupTurn();
      const { manager, sessionId, dispatch, committed, reload, views, events } = turn;
      dispatch({
        type: "turn-complete",
        message: { id: "earlier", role: "assistant", content: "Earlier update." },
      });
      dispatchAtCheckpointIntervals(dispatch, partialActivity);

      const send = vi.spyOn(manager, "sendMessage").mockImplementation(async () => {
        // The new prompt must not clear the old turn before its commit reaches the view.
        expect(committed()).toHaveLength(2);
        expect(reload()).toEqual(committed());
      });
      if (action === "steer") {
        await manager.steerMessage(sessionId, "Check the other caller");
      } else {
        await manager.cancelTurn(sessionId);
        await manager.cancelTurn(sessionId);
      }
      const steeringOptions = expect.objectContaining({
        backendPromptContent: expect.stringMatching(
          /^<system_instruction>[\s\S]*Check the other caller$/,
        ),
      });
      expect(send.mock.calls).toEqual(
        action === "steer"
          ? [[sessionId, "Check the other caller", undefined, steeringOptions]]
          : [],
      );

      expect(committed()).toHaveLength(2);
      const partial = committed()[1];
      expect(partial).toMatchObject({
        role: "assistant",
        content: "I found the relevant code.",
        reasoning: { text: "Inspect the failing path.Now check the caller." },
        toolCalls: [
          { id: "read", output: "File contents", success: true },
          { id: "search", input: expect.stringContaining("caller"), cancelled: true },
        ],
        contentBlocks: [
          { type: "reasoning", text: "Inspect the failing path." },
          { type: "text", content: "I found the relevant code." },
          { type: "tools", toolCalls: [{ id: "read", output: "File contents" }] },
          { type: "reasoning", text: "Now check the caller." },
          { type: "tools", toolCalls: [{ id: "search", running: false, cancelled: true }] },
        ],
      });
      expect(reload()).toEqual(committed());
      const committedIndex = events.findLastIndex(
        (event) => event.type === "turn:message-committed",
      );
      const idleIndex = events.findIndex((event) => event.type === "turn:idle");
      expect(committedIndex).toBeLessThan(idleIndex);
      expect(views.at(-1)?.view).toMatchObject({
        status: "ready",
        streamingText: "",
        reasoning: null,
        toolStatuses: [],
      });

      // The original subscription stays fenced after cancellation completes.
      dispatch({ type: "text-delta", text: "Late cancelled output" });
      dispatch({ type: "idle" });
      expect(reload()).toEqual(committed());
      expect(committed()).toHaveLength(2);
    },
  );

  it("keeps partial activity when backend cancellation fails", async () => {
    const { manager, backend, sessionId, dispatch, committed, reload } = await setupTurn();
    dispatchAtCheckpointIntervals(dispatch, partialActivity);
    vi.mocked(backend.sessions.abort).mockRejectedValue(new Error("Abort rejected"));
    await expect(manager.cancelTurn(sessionId)).rejects.toThrow("Cancellation failed");
    expect(committed()).toHaveLength(1);
    expect(committed()[0]).toMatchObject({
      content: "I found the relevant code.",
      reasoning: { text: "Inspect the failing path.Now check the caller." },
      toolCalls: [{ id: "read", output: "File contents" }, { id: "search" }],
    });
    expect(reload()).toEqual(committed());
  });

  it.each([
    { type: "reasoning-delta", text: "Still thinking" },
    { type: "tool-start", toolCallId: "read", toolName: "read_file" },
  ] satisfies BackendEvent[])("keeps activity without assistant text: %j", async (event) => {
    const { manager, sessionId, dispatch, committed, reload } = await setupTurn();
    dispatch(event);
    await manager.cancelTurn(sessionId);
    expect(committed()).toHaveLength(1);
    expect(committed()[0].content).toBe("");
    expect(reload()).toEqual(committed());
  });

  it("does not create an empty message when cancelled before any activity", async () => {
    const { manager, sessionId, committed, reload } = await setupTurn();
    await manager.cancelTurn(sessionId);
    expect(committed()).toEqual([]);
    expect(reload()).toEqual([]);
  });

  it("persists interrupted messages even when another message has the current timestamp as its ID", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const { manager, sessionId, dispatch, committed, reload } = await setupTurn();
      dispatch({
        type: "turn-complete",
        message: { id: String(Date.now()), role: "assistant", content: "Earlier update." },
      });
      dispatch({ type: "text-delta", text: "More progress" });
      await manager.cancelTurn(sessionId);
      expect(committed()).toHaveLength(2);
      expect(reload()).toEqual(committed());
      expect(committed()[1].id).not.toBe(committed()[0].id);
    } finally {
      now.mockRestore();
    }
  });

  it("preserves internal-control metadata on interrupted responses", async () => {
    const { manager, access, sessionId, dispatch, committed, reload } = await setupTurn();
    const internalControl: SessionInternalControlMetadata = {
      kind: "goal-continuation",
      exchangeId: "goal-1",
      side: "response",
    };
    access.activeInternalControlTurns.set(sessionId, internalControl);
    dispatch({ type: "text-delta", text: "Goal progress" });
    await manager.cancelTurn(sessionId);
    expect(committed()).toEqual([expect.objectContaining({ internalControl })]);
    expect(reload()).toEqual(committed());
  });

  it("publishes the idle safety-net message before clearing the live turn", async () => {
    const { dispatch, committed, reload, views } = await setupTurn();
    for (const event of partialActivity) dispatch(event);
    dispatch({ type: "idle" });
    expect(committed()).toHaveLength(1);
    expect(reload()).toEqual(committed());
    expect(views.at(-1)?.view.status).toBe("ready");
    dispatch({ type: "idle" });
    expect(committed()).toHaveLength(1);
  });
});
