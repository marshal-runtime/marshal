/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import type { GoalRecord } from "../common/goal-contract";
import { createInitialGoalDocument } from "./schemas/goal-schema";
import type { IGoalSessionsEngine, IGoalSessionsManager } from "./sessions";
import { createTestBackend, testDouble } from "./testing/harness";

const mockedFs = vi.mocked(fs);

/**
 * Production-wiring regression tests for goal dispatch readiness: pursuing
 * goals must park (not burn error budget or durably block) while the backend
 * is signed out, a login is in flight, or the session belongs to an inactive
 * runtime — and must be woken by the real auth-verification paths.
 */
describe("SessionManager goal dispatch readiness", () => {
  let mgr: any;
  let signalResumeTrigger: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
  let goals: Map<string, GoalRecord>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readdirSync.mockReturnValue([]);
    mockedFs.readFileSync.mockReturnValue("{}");
    const { SessionManager } = await import("./sessions");
    mgr = new SessionManager("/test/workspace", await createTestBackend());
    goals = new Map<string, GoalRecord>([
      ["pursuing-copilot", createInitialGoalDocument({ objective: "Copilot work" })],
      [
        "paused-copilot",
        { ...createInitialGoalDocument({ objective: "Paused work" }), status: "paused" },
      ],
      ["pursuing-gateway", createInitialGoalDocument({ objective: "Gateway work" })],
    ]);
    signalResumeTrigger = vi.fn<(sessionId: string) => void>();
    mgr.setGoalIntegration(
      testDouble<IGoalSessionsManager>({ getGoal: (id: string) => goals.get(id) ?? null }),
      testDouble<IGoalSessionsEngine>({
        start: signalResumeTrigger,
        signalResumeTrigger,
        pause: vi.fn<(sessionId: string) => void>(),
        stop: vi.fn<(sessionId: string) => void>(),
        isRunning: () => false,
        proposeTransition: () => false,
      }),
    );
    // Index/session rows: runtime resolution uses runtimeId (rule 2); the
    // gateway row must never be woken or dispatch-ready under Copilot.
    const rows = [
      { id: "pursuing-copilot", runtimeId: "copilot" },
      { id: "paused-copilot", runtimeId: "copilot" },
      { id: "pursuing-gateway", runtimeId: "gateway", backendOrigin: "gateway" },
    ];
    mgr.store.loadIndex = () => ({ sessions: rows });
    mgr.store.loadSessionData = (id: string) => rows.find((row) => row.id === id) ?? null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function stubBackendAuth(authenticated: boolean) {
    mgr.backend.checkAuthStatus = vi.fn<
      () => Promise<{ authenticated: boolean; username: string }>
    >(async () => ({ authenticated, username: "user" }));
  }

  it("parks dispatch until an affirmatively verified authentication", async () => {
    // Unknown auth (fresh boot, no check yet) parks — merely opening a
    // signed-out session must not feed the engine's error budget.
    expect(mgr.isGoalDispatchReady("pursuing-copilot")).toBe(false);

    stubBackendAuth(false);
    await mgr.checkAuthStatus();
    expect(mgr.isGoalDispatchReady("pursuing-copilot")).toBe(false);
    expect(signalResumeTrigger).not.toHaveBeenCalled();

    stubBackendAuth(true);
    await mgr.checkAuthStatus();
    expect(mgr.isGoalDispatchReady("pursuing-copilot")).toBe(true);
    // Runtime mismatch still parks (rule 2 partition), as do auth transitions.
    expect(mgr.isGoalDispatchReady("pursuing-gateway")).toBe(false);
    mgr.loginInProgress = true;
    expect(mgr.isGoalDispatchReady("pursuing-copilot")).toBe(false);
    mgr.loginInProgress = false;
    mgr.signOutPromise = Promise.resolve();
    expect(mgr.isGoalDispatchReady("pursuing-copilot")).toBe(false);
  });

  it("wakes active-runtime pursuing goals on the first authenticated check only", async () => {
    stubBackendAuth(true);
    await mgr.checkAuthStatus();
    expect(signalResumeTrigger).toHaveBeenCalledTimes(1);
    expect(signalResumeTrigger).toHaveBeenCalledWith("pursuing-copilot");

    // No transition on a repeat check — no duplicate wake.
    await mgr.checkAuthStatus();
    expect(signalResumeTrigger).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale auth result from a backend replaced mid-check", async () => {
    let resolveAuth!: (value: { authenticated: boolean; username: string }) => void;
    mgr.backend.checkAuthStatus = vi.fn<
      () => Promise<{ authenticated: boolean; username: string }>
    >(
      () =>
        new Promise((resolve) => {
          resolveAuth = resolve;
        }),
    );
    const pending = mgr.checkAuthStatus();
    // Runtime switch lands while the old backend's check is in flight.
    mgr.backend = await createTestBackend();
    mgr.lastKnownAuthenticated = null;
    resolveAuth({ authenticated: true, username: "user" });
    await pending;
    // The old backend's authentication must not unlock the incoming backend.
    expect(mgr.lastKnownAuthenticated).toBeNull();
    expect(mgr.isGoalDispatchReady("pursuing-copilot")).toBe(false);
    expect(signalResumeTrigger).not.toHaveBeenCalled();
  });

  it("a synchronous login after sign-out verifies auth and wakes parked goals", async () => {
    stubBackendAuth(true);
    // Post-sign-out state: cache is affirmatively false, goals parked.
    mgr.lastKnownAuthenticated = false;
    expect(mgr.isGoalDispatchReady("pursuing-copilot")).toBe(false);

    // Synchronous login (no completion phase) — must verify with a real
    // check instead of trusting the stale false cache.
    mgr.backend.login = vi.fn<() => Promise<Record<string, never>>>(async () => ({}));
    await mgr.login();
    await vi.waitFor(() => expect(signalResumeTrigger).toHaveBeenCalledWith("pursuing-copilot"));
    expect(mgr.loginInProgress).toBe(false);
    expect(mgr.isGoalDispatchReady("pursuing-copilot")).toBe(true);
  });

  it("a verified login wakes goals even when the cache was already authenticated", async () => {
    vi.useFakeTimers();
    stubBackendAuth(true);
    await mgr.checkAuthStatus();
    expect(signalResumeTrigger).toHaveBeenCalledTimes(1);

    // Goals park during the login window regardless of the prior cache value.
    mgr.loginInProgress = true;
    expect(mgr.isGoalDispatchReady("pursuing-copilot")).toBe(false);

    mgr.initClient = vi.fn<() => Promise<void>>(async () => {});
    mgr.backend.isReady = () => true;
    const verify = mgr.verifyAuthAfterLogin(mgr.backend);
    await vi.advanceTimersByTimeAsync(1_500);
    await verify;

    expect(mgr.loginInProgress).toBe(false);
    expect(mgr.isGoalDispatchReady("pursuing-copilot")).toBe(true);
    // The post-login wake fired despite no false→true cache transition.
    expect(signalResumeTrigger).toHaveBeenCalledTimes(2);
    expect(signalResumeTrigger).toHaveBeenLastCalledWith("pursuing-copilot");
  });
});
