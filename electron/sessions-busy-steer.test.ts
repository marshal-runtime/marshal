/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
vi.mock("fs", m.fsFactory);
vi.mock("./session-archive", m.sessionArchiveFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", m.skillsFactory);
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file");

import * as fs from "fs";

import { createTestBackend } from "./testing/harness";

const mockedFs = vi.mocked(fs);

const SESSION_ID = "steer-1";

/**
 * Integration coverage for the host-layer steer path (live 9388 regression):
 * copilotAPI.steer → copilot:steer → SessionManager.steerMessage →
 * backend.sessions.send. When the backend advertises busyTurnSteer (Codex
 * turn/steer), steering a busy session must run the FULL send pipeline
 * without cancelling the active turn — the in-flight tool, stream
 * accumulator, and any completion waiter on the original turn survive.
 * Backends without the capability keep the cancel+resend fallback verbatim.
 */
describe("SessionManager.steerMessage — native busy-turn steer", () => {
  let mgr: any;
  let row: any;
  let sendSpy: ReturnType<typeof vi.fn>;
  let abortSpy: ReturnType<typeof vi.fn>;
  let cancelSpy: any;
  let events: Array<{ sessionId: string; type: string }>;

  async function setup(options: { busyTurnSteer: boolean }): Promise<void> {
    vi.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readdirSync.mockReturnValue([]);
    mockedFs.readFileSync.mockReturnValue("{}");
    const { SessionManager } = await import("./sessions");
    mgr = new SessionManager("/test/workspace", await createTestBackend());

    row = {
      id: SESSION_ID,
      runtimeId: "copilot",
      source: "user",
      name: "Existing chat",
      model: "test-model",
      soul: "default",
      messages: [],
    };
    mgr.store.loadIndex = () => ({ sessions: [row] });
    mgr.store.loadSessionData = (id: string) => (id === SESSION_ID ? row : null);
    mgr.store.saveSessionData = vi.fn<(data: unknown) => void>();
    mgr.store.withIndexLock = vi.fn<(cb: (index: any) => unknown) => Promise<unknown>>(async (cb) =>
      cb({ sessions: [row] }),
    );

    const baseCapabilities = mgr.backend.capabilities();
    mgr.backend.capabilities = () => ({
      ...baseCapabilities,
      busyTurnSteer: options.busyTurnSteer,
    });
    sendSpy = vi.fn<() => Promise<void>>(async () => {});
    abortSpy = vi.fn<() => Promise<object>>(async () => ({}));
    mgr.backend.sessions.send = sendSpy;
    mgr.backend.sessions.abort = abortSpy;
    // The real cancelTurn interrupts the backend and emits a synthetic idle;
    // stub it to the observable essentials so the fallback test can assert
    // ordering without the full backend event plumbing.
    cancelSpy = vi.spyOn(mgr, "cancelTurn").mockImplementation(async () => {
      mgr.busyTracker.setIdle(SESSION_ID);
      mgr.turnAccumulators.delete(SESSION_ID);
      mgr.viewEmission.emitEvent(SESSION_ID, { type: "turn:idle" });
    });

    // Seed a live busy turn with in-flight state that must survive a steer.
    mgr.sessionHandles.set(SESSION_ID, { backendId: "backend-1" });
    mgr.setSessionBusy(SESSION_ID);
    mgr.turnAccumulators.set(SESSION_ID, { sentinel: "live-turn-accumulator" });

    events = [];
    mgr.addEventListener((sessionId: string, event: { type: string }) => {
      events.push({ sessionId, type: event.type });
    });
  }

  describe("backend with busyTurnSteer (codex)", () => {
    beforeEach(async () => {
      await setup({ busyTurnSteer: true });
    });

    it("runs the full send pipeline into the active turn without cancelling it", async () => {
      await mgr.steerMessage(SESSION_ID, "steer the live turn", undefined, {
        clientMessageId: "steer-msg-1",
      });

      // Delivery went through the normal backend send pipeline.
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy.mock.calls[0][0]).toBe(SESSION_ID);
      expect(sendSpy.mock.calls[0][1]).toMatchObject({
        prompt: expect.stringMatching(/^<system_instruction>[\s\S]*steer the live turn$/),
      });
      // The steering user message was committed to history and the view.
      expect(row.messages).toHaveLength(1);
      expect(row.messages[0]).toMatchObject({
        role: "user",
        content: "steer the live turn",
        id: "steer-msg-1",
      });
      expect(events).toContainEqual({ sessionId: SESSION_ID, type: "turn:message-committed" });

      // The active turn was NOT interrupted: no cancel, no abort, no synthetic
      // idle, the stream/tool accumulator survives, and the session stays busy
      // so the original turn's completion waiter still resolves off the real
      // turn events.
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(abortSpy).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === "turn:idle")).toBe(false);
      expect(mgr.turnAccumulators.get(SESSION_ID)).toEqual({
        sentinel: "live-turn-accumulator",
      });
      expect(mgr.isSessionBusy(SESSION_ID)).toBe(true);
      // The steer send released its token — a follow-up steer is not blocked.
      expect(mgr.activeSessionSendTokens.has(SESSION_ID)).toBe(false);
    });

    it("propagates a native steer failure without cancelling or retrying", async () => {
      sendSpy.mockRejectedValueOnce(new Error("[codex-app-server] turn/steer failed"));

      await expect(mgr.steerMessage(SESSION_ID, "will fail")).rejects.toThrow("turn/steer failed");

      expect(sendSpy).toHaveBeenCalledTimes(1); // no silent retry
      expect(cancelSpy).not.toHaveBeenCalled(); // no silent cancel fallback
      expect(abortSpy).not.toHaveBeenCalled();
      expect(mgr.turnAccumulators.get(SESSION_ID)).toEqual({
        sentinel: "live-turn-accumulator",
      });
      expect(mgr.isSessionBusy(SESSION_ID)).toBe(true);
    });

    it("keeps the in-flight send guard: a literally concurrent send still conflicts", async () => {
      mgr.activeSessionSendTokens.set(SESSION_ID, { lifecycleToken: {}, cancelled: false });

      await expect(mgr.steerMessage(SESSION_ID, "overlapping")).rejects.toThrow(
        "Another message or turn is already active for this session",
      );
      expect(sendSpy).not.toHaveBeenCalled();
      expect(cancelSpy).not.toHaveBeenCalled();
    });

    it("still rejects a plain busy send without the steer flag", async () => {
      await expect(mgr.sendMessage(SESSION_ID, "not a steer")).rejects.toThrow(
        "Another message or turn is already active for this session",
      );
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("sends normally when the session is idle (no steer detour)", async () => {
      mgr.busyTracker.setIdle(SESSION_ID);

      await mgr.steerMessage(SESSION_ID, "idle send");

      // Idle sessions take the fallback path; its cancelTurn is a no-op cancel
      // of nothing, and the message still goes out exactly once.
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy.mock.calls[0][1]).toMatchObject({ prompt: "idle send" });
    });
  });

  describe("backend without busyTurnSteer (copilot/gateway fallback)", () => {
    beforeEach(async () => {
      await setup({ busyTurnSteer: false });
    });

    it("keeps the cancel-then-send fallback unchanged", async () => {
      await mgr.steerMessage(SESSION_ID, "legacy steer");

      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy.mock.calls[0][1]).toMatchObject({
        prompt: expect.stringMatching(/^<system_instruction>[\s\S]*legacy steer$/),
      });
      // Cancel ran before the send dispatched.
      expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
        sendSpy.mock.invocationCallOrder[0],
      );
    });
  });

  describe("interrupting agent messages yield to a turn the user started", () => {
    const parentReport = { target: SESSION_ID, deliveryMode: "interrupt", kind: "parent" };

    beforeEach(async () => {
      await setup({ busyTurnSteer: false });
      mgr.resolveSessionData = async (id: string) => (id === SESSION_ID ? row : null);
    });

    it("holds a subagent report until the user's steered turn ends", async () => {
      await mgr.steerMessage(SESSION_ID, "answer me now");
      cancelSpy.mockClear();

      expect(mgr.isSessionBusy(SESSION_ID)).toBe(true);
      expect(mgr.canDeliverAgentMessage(parentReport)).toBe(false);
      await expect(
        mgr.deliverAgentMessage(
          { ...parentReport, messageId: "m-1", source: "child-1", content: "lane report" },
          {
            markBackendAccepted: vi.fn<() => Promise<void>>(),
            markBackendDelivered: vi.fn<() => Promise<void>>(),
          },
        ),
      ).resolves.toMatchObject({ state: "pending", attemptConsumed: false });
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(sendSpy).toHaveBeenCalledTimes(1);

      mgr.busyTracker.setIdle(SESSION_ID);
      expect(mgr.canDeliverAgentMessage(parentReport)).toBe(true);
    });

    it("still lets a relayed user message interrupt", async () => {
      await mgr.steerMessage(SESSION_ID, "answer me now");

      expect(mgr.canDeliverAgentMessage({ ...parentReport, kind: "relay" })).toBe(true);
    });

    it("still interrupts a turn that an agent message started", async () => {
      mgr.busyTracker.setIdle(SESSION_ID);
      await mgr.sendMessage(SESSION_ID, "lane report", undefined, {
        agentMessage: { source: "child-1", kind: "parent", deliveryMode: "queue", sequence: 1 },
      });

      expect(mgr.isSessionBusy(SESSION_ID)).toBe(true);
      expect(mgr.canDeliverAgentMessage(parentReport)).toBe(true);
    });

    it("keeps queued messages out while a user steer is between cancel and dispatch", async () => {
      let deliverableMidSteer: boolean | undefined;
      cancelSpy.mockImplementation(async () => {
        mgr.busyTracker.setIdle(SESSION_ID);
        deliverableMidSteer = mgr.canDeliverAgentMessage({
          ...parentReport,
          deliveryMode: "queue",
        });
      });

      await mgr.steerMessage(SESSION_ID, "answer me now");

      expect(deliverableMidSteer).toBe(false);
      expect(mgr.pendingUserSteers.has(SESSION_ID)).toBe(false);
    });
  });
});
