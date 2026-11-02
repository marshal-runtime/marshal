import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentWakeRequest, RuntimeWakePort } from "@marshal/agent-runtime-effects";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

import type { PermissionPolicy } from "../permission-policy";
import type { PersistedSession } from "../session-store";
import type { SessionManager } from "../sessions";
import { testDouble } from "../testing/harness";
import {
  createDesktopRuntimeWakes,
  createSessionWakePort,
  MAX_LIVE_WAKES,
  WAKE_TURN_TIMEOUT_MS,
  type DesktopRuntimeWakes,
} from "./runtime-wakes";

const SESSION_ID = "session-1";
const OTHER_SESSION_ID = "session-2";
const MESSAGE = "Look at the build again";
const OTHER_MESSAGE = "Check the deploy";
const T0 = new Date("2030-01-01T10:00:00.000Z");
const MS_PER_MINUTE = 60_000;
const MINUTES_AHEAD = 5;
const RETRY_DELAY_MINUTES = 1;
const FIRE_ID = "fire-1";
const SCHEDULE_ID = "sch-1";

const minutesFromStart = (minutes: number): Date =>
  new Date(T0.getTime() + minutes * MS_PER_MINUTE);

describe("createDesktopRuntimeWakes", () => {
  let directory: string;
  let clock: Date;
  let wake: Mock<RuntimeWakePort["wake"]>;
  let wakes: DesktopRuntimeWakes;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-wakes-"));
    clock = T0;
    wake = vi.fn<RuntimeWakePort["wake"]>().mockResolvedValue(undefined);
    wakes = createDesktopRuntimeWakes({
      userDataDirectory: directory,
      wakePort: { wake },
      now: () => clock,
    });
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  describe("Sanity", () => {
    it("fires a stored wake once, at its moment, with the target session and message", async () => {
      const at = minutesFromStart(MINUTES_AHEAD);
      const stored = await wakes.schedule({ sessionId: SESSION_ID, message: MESSAGE, at });
      expect(stored).toEqual({ scheduleId: expect.stringMatching(/^sch-/), at: at.toISOString() });

      clock = minutesFromStart(MINUTES_AHEAD - 1);
      expect(await wakes.service.tick(clock)).toEqual({ fired: 0, failed: 0 });
      expect(wake).not.toHaveBeenCalled();

      clock = at;
      expect(await wakes.service.tick(clock)).toEqual({ fired: 1, failed: 0 });
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledWith(
        expect.objectContaining({ target: { sessionId: SESSION_ID }, message: MESSAGE }),
      );

      clock = minutesFromStart(MINUTES_AHEAD + 10);
      expect(await wakes.service.tick(clock)).toEqual({ fired: 0, failed: 0 });
      expect(wake).toHaveBeenCalledTimes(1);
    });

    it("fires a wake that fell due while the app was closed, from the stored file", async () => {
      await wakes.schedule({
        sessionId: SESSION_ID,
        message: MESSAGE,
        at: minutesFromStart(MINUTES_AHEAD),
      });
      const restarted = createDesktopRuntimeWakes({
        userDataDirectory: directory,
        wakePort: { wake },
        now: () => minutesFromStart(MINUTES_AHEAD * 4),
      });
      expect(await restarted.service.tick(minutesFromStart(MINUTES_AHEAD * 4))).toEqual({
        fired: 1,
        failed: 0,
      });
    });

    it("keeps each wake on its own session and message", async () => {
      const at = minutesFromStart(MINUTES_AHEAD);
      await wakes.schedule({ sessionId: SESSION_ID, message: MESSAGE, at });
      await wakes.schedule({ sessionId: OTHER_SESSION_ID, message: OTHER_MESSAGE, at });
      clock = at;
      await wakes.service.tick(clock);
      const delivered = wake.mock.calls.map(([request]) => [
        request.target.sessionId,
        request.message,
      ]);
      expect(delivered).toHaveLength(2);
      expect(delivered).toEqual(
        expect.arrayContaining([
          [SESSION_ID, MESSAGE],
          [OTHER_SESSION_ID, OTHER_MESSAGE],
        ]),
      );
    });

    it("cancels a live wake so it never fires", async () => {
      const at = minutesFromStart(MINUTES_AHEAD);
      const { scheduleId } = await wakes.schedule({ sessionId: SESSION_ID, message: MESSAGE, at });
      expect(await wakes.cancel(scheduleId)).toBe(true);
      clock = at;
      expect(await wakes.service.tick(clock)).toEqual({ fired: 0, failed: 0 });
      expect(wake).not.toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("refuses a wake in the past", async () => {
      await expect(
        wakes.schedule({ sessionId: SESSION_ID, message: MESSAGE, at: minutesFromStart(-10) }),
      ).rejects.toBeInstanceOf(Error);
    });

    it("refuses a wake past the live limit", async () => {
      const at = minutesFromStart(MINUTES_AHEAD);
      await Promise.all(
        Array.from({ length: MAX_LIVE_WAKES }, () =>
          wakes.schedule({ sessionId: SESSION_ID, message: MESSAGE, at }),
        ),
      );
      await expect(wakes.schedule({ sessionId: SESSION_ID, message: MESSAGE, at })).rejects.toThrow(
        String(MAX_LIVE_WAKES),
      );
    });

    it("retries a wake whose delivery failed and fires it once it succeeds", async () => {
      const at = minutesFromStart(MINUTES_AHEAD);
      await wakes.schedule({ sessionId: SESSION_ID, message: MESSAGE, at });
      wake.mockRejectedValueOnce(new Error("Target session 'session-1' not found"));

      clock = at;
      expect(await wakes.service.tick(clock)).toEqual({ fired: 0, failed: 1 });

      clock = minutesFromStart(MINUTES_AHEAD + RETRY_DELAY_MINUTES);
      expect(await wakes.service.tick(clock)).toEqual({ fired: 1, failed: 0 });
      expect(wake).toHaveBeenCalledTimes(2);
    });
  });

  describe("Edge Cases", () => {
    it("answers false when cancelling an unknown id", async () => {
      expect(await wakes.cancel("sch-unknown")).toBe(false);
    });

    it("answers false when cancelling a wake that already fired", async () => {
      const at = minutesFromStart(MINUTES_AHEAD);
      const { scheduleId } = await wakes.schedule({ sessionId: SESSION_ID, message: MESSAGE, at });
      clock = at;
      await wakes.service.tick(clock);
      expect(await wakes.cancel(scheduleId)).toBe(false);
    });

    it("refuses an empty message", async () => {
      await expect(
        wakes.schedule({
          sessionId: SESSION_ID,
          message: "  ",
          at: minutesFromStart(MINUTES_AHEAD),
        }),
      ).rejects.toBeInstanceOf(Error);
    });
  });
});

describe("createSessionWakePort", () => {
  const request = (sessionId: string | undefined) =>
    testDouble<AgentWakeRequest>({
      target: sessionId ? { sessionId } : {},
      message: MESSAGE,
      fire: { fireId: FIRE_ID, scheduleId: SCHEDULE_ID },
    });

  interface Overrides {
    getSession?: SessionManager["getSession"];
    getSessionAsync?: SessionManager["getSessionAsync"];
    switchSession?: SessionManager["switchSession"];
    sendAndCollect?: SessionManager["sendAndCollect"];
  }

  const existingSession = testDouble<PersistedSession>({ id: SESSION_ID });

  const build = (overrides: Overrides = {}) => {
    const sessionManager = {
      getSession: vi.fn<SessionManager["getSession"]>().mockReturnValue(existingSession),
      getSessionAsync: vi.fn<SessionManager["getSessionAsync"]>().mockResolvedValue(null),
      switchSession: vi
        .fn<SessionManager["switchSession"]>()
        .mockResolvedValue({ kind: "hydrating" }),
      appendMessage: vi.fn<SessionManager["appendMessage"]>(),
      sendAndCollect: vi
        .fn<SessionManager["sendAndCollect"]>()
        .mockResolvedValue({ kind: "ok", text: "done" }),
    };
    Object.assign(sessionManager, overrides);
    const permissionPolicy = {
      setDenyPrompt: vi.fn<PermissionPolicy["setDenyPrompt"]>(),
      markUnattended: vi.fn<PermissionPolicy["markUnattended"]>(),
    };
    const port = createSessionWakePort({ sessionManager, permissionPolicy });
    return { sessionManager, permissionPolicy, port };
  };

  describe("Sanity", () => {
    it("resumes the session unattended and sends the message as a turn", async () => {
      const { sessionManager, permissionPolicy, port } = build();
      await port.wake(request(SESSION_ID));

      expect(sessionManager.switchSession).toHaveBeenCalledWith(SESSION_ID);
      expect(permissionPolicy.setDenyPrompt).toHaveBeenCalledWith(SESSION_ID);
      expect(permissionPolicy.markUnattended).toHaveBeenCalledWith(SESSION_ID);
      expect(sessionManager.appendMessage).toHaveBeenCalledWith(
        SESSION_ID,
        expect.objectContaining({ id: `wake-${FIRE_ID}`, role: "user", content: MESSAGE }),
      );
      expect(sessionManager.sendAndCollect).toHaveBeenCalledWith(
        MESSAGE,
        WAKE_TURN_TIMEOUT_MS,
        undefined,
        SESSION_ID,
        undefined,
        { clientMessageId: `runtime-wake:${FIRE_ID}` },
      );
    });

    it("loads a session that is not in memory", async () => {
      const { sessionManager, port } = build({
        getSession: vi.fn<SessionManager["getSession"]>().mockReturnValue(null),
        getSessionAsync: vi
          .fn<SessionManager["getSessionAsync"]>()
          .mockResolvedValue(existingSession),
      });
      await port.wake(request(SESSION_ID));
      expect(sessionManager.sendAndCollect).toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("raises when the session does not exist, so the scheduler retries", async () => {
      const { sessionManager, port } = build({
        getSession: vi.fn<SessionManager["getSession"]>().mockReturnValue(null),
        getSessionAsync: vi.fn<SessionManager["getSessionAsync"]>().mockResolvedValue(null),
      });
      await expect(port.wake(request(SESSION_ID))).rejects.toThrow("not found");
      expect(sessionManager.sendAndCollect).not.toHaveBeenCalled();
    });

    it("raises when switching to the session finds nothing", async () => {
      const { sessionManager, port } = build({
        switchSession: vi
          .fn<SessionManager["switchSession"]>()
          .mockResolvedValue({ kind: "notFound" }),
      });
      await expect(port.wake(request(SESSION_ID))).rejects.toThrow("not found");
      expect(sessionManager.sendAndCollect).not.toHaveBeenCalled();
    });

    it("raises when the wake names no session", async () => {
      const { port } = build();
      await expect(port.wake(request(undefined))).rejects.toThrow("sessionId");
    });
  });

  describe("Edge Cases", () => {
    it.each(["timeout", "no-response"] as const)(
      "does not raise when the turn ends with %s, so the message is not sent twice",
      async (kind) => {
        const { sessionManager, port } = build({
          sendAndCollect: vi
            .fn<SessionManager["sendAndCollect"]>()
            .mockResolvedValue({ kind, text: "" }),
        });
        await expect(port.wake(request(SESSION_ID))).resolves.toBeUndefined();
        expect(sessionManager.sendAndCollect).toHaveBeenCalledTimes(1);
      },
    );
  });
});
