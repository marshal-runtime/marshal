// Marshal-owned test
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IpcInvokeMap } from "../../common/marshal-ipc-contract";
import type { AIInvestigatorManager } from "../ai-investigator/ai-investigator-manager";
import { makeAIInvestigatorEmitter, registerAIInvestigatorHandlers } from "./ai-investigator-ipc";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function setup() {
  const handlers = new Map<string, Handler>();
  const ipcHandle = vi.fn<(channel: keyof IpcInvokeMap, handler: unknown) => void>(
    (channel, handler) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test bridge: storing erased handler
      handlers.set(channel as string, handler as Handler);
    },
  );
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial mock: only methods exercised by IPC handlers
  const manager = {
    start: vi.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
    cancel: vi.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
    reset: vi.fn<() => void>(),
    post: vi
      .fn<() => Promise<{ success: true; url: string }>>()
      .mockResolvedValue({ success: true, url: "https://example/issues/1" }),
    getStatus: vi
      .fn<() => { state: string; userDescription: string; log: unknown[] }>()
      .mockReturnValue({
        state: "idle",
        userDescription: "",
        log: [],
      }),
    checkAvailability: vi
      .fn<() => Promise<{ available: boolean; reason?: string }>>()
      .mockResolvedValue({ available: true }),
  } as unknown as AIInvestigatorManager;
  registerAIInvestigatorHandlers({
    ipcHandle: ipcHandle as Parameters<typeof registerAIInvestigatorHandlers>[0]["ipcHandle"],
    aiInvestigatorManager: manager,
  });
  return { handlers, manager };
}

describe("registerAIInvestigatorHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers all six aiInvestigator channels", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([
      "aiInvestigator:cancel",
      "aiInvestigator:checkAvailability",
      "aiInvestigator:getStatus",
      "aiInvestigator:post",
      "aiInvestigator:reset",
      "aiInvestigator:start",
    ]);
  });

  it("rejects start with empty description", async () => {
    const { handlers } = setup();
    const result = await handlers.get("aiInvestigator:start")!({}, { userDescription: "  " });
    expect(result).toMatchObject({ success: false });
  });

  it("rejects start with missing payload", async () => {
    const { handlers } = setup();
    const result = await handlers.get("aiInvestigator:start")!({}, undefined);
    expect(result).toMatchObject({ success: false });
  });

  it("forwards a valid start payload to the manager", async () => {
    const { handlers, manager } = setup();
    const result = await handlers.get("aiInvestigator:start")!(
      {},
      { userDescription: "thing broke" },
    );
    expect(result).toEqual({ success: true });
    expect(manager.start).toHaveBeenCalledWith({
      userDescription: "thing broke",
    });
  });

  it("returns the manager's status verbatim", async () => {
    const { handlers, manager } = setup();
    const result = await handlers.get("aiInvestigator:getStatus")!({});
    expect(manager.getStatus).toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      status: { state: "idle", userDescription: "", log: [] },
    });
  });

  it("delegates cancel and post to the manager", async () => {
    const { handlers, manager } = setup();
    const cancelResult = await handlers.get("aiInvestigator:cancel")!({});
    expect(cancelResult).toEqual({ success: true });
    expect(manager.cancel).toHaveBeenCalled();
    const postResult = await handlers.get("aiInvestigator:post")!({});
    expect(postResult).toEqual({ success: true, url: "https://example/issues/1" });
    expect(manager.post).toHaveBeenCalled();
  });

  it("reset handler calls manager.reset() and returns success", async () => {
    const { handlers, manager } = setup();
    const result = await handlers.get("aiInvestigator:reset")!({});
    expect(result).toEqual({ success: true });
    expect(manager.reset).toHaveBeenCalled();
  });

  it("checkAvailability returns success:false when the manager throws", async () => {
    const { handlers, manager } = setup();
    vi.mocked(manager.checkAvailability).mockRejectedValueOnce(new Error("probe failed"));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- handler returns unknown; casting to concrete contract type for assertions
    const result = (await handlers.get("aiInvestigator:checkAvailability")!({})) as {
      success: boolean;
      available: boolean;
      reason?: string;
    };
    expect(result).toMatchObject({ success: false, available: false });
    expect(result.reason).toMatch(/probe failed/);
  });
});

describe("makeAIInvestigatorEmitter", () => {
  it("sends events to the active window's webContents", () => {
    const send = vi.fn<(channel: string, payload: unknown) => void>();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal BrowserWindow stub
    const win = { webContents: { send } } as unknown as Electron.BrowserWindow;
    const emit = makeAIInvestigatorEmitter(() => win);
    emit({ type: "status", state: "investigating" });
    expect(send).toHaveBeenCalledWith("aiInvestigator:event", {
      type: "status",
      state: "investigating",
    });
  });

  it("no-ops when no window is available", () => {
    const emit = makeAIInvestigatorEmitter(() => null);
    expect(() => emit({ type: "status", state: "idle" })).not.toThrow();
  });
});
