import type { GoalRecord, GoalRuntimeSnapshot, GoalStatus } from "@common/goal-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent, waitFor } from "@/test-utils";
import type { GoalAPI } from "@/types/electron";

import { GoalWidget } from "./GoalWidget";
import { getGoalSnapshotView } from "./snapshotView";

const fence = { goalId: "g1", epoch: 2 } as const;

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    schemaVersion: 3,
    id: "g1",
    epoch: 2,
    objective: "Ship onboarding cleanup",
    criteria: [],
    status: "pursuing",
    createdAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:01:00.000Z",
    startedPursuingAt: "2026-08-20T12:00:00.000Z",
    progress: [],
    openQuestions: [],
    assumptions: [],
    decisions: [],
    state: {},
    continuationCount: 3,
    activeMs: 5_000,
    tokensUsed: 4_200,
    ...overrides,
  };
}

function makeSnapshot(goalOverrides: Partial<GoalRecord> = {}): GoalRuntimeSnapshot {
  return {
    sessionId: "s1",
    goal: makeGoal(goalOverrides),
    fence,
  };
}

function ok(snapshot: GoalRuntimeSnapshot = makeSnapshot()) {
  return { success: true as const, snapshot };
}

function renderWidget(snapshot: GoalRuntimeSnapshot | null, goalAPI: Partial<GoalAPI> = {}) {
  installMockAPIs({
    goalAPI: {
      get: vi.fn<GoalAPI["get"]>().mockResolvedValue({ success: true, snapshot }),
      ...goalAPI,
    },
  });
  return render(<GoalWidget sessionId="s1" />);
}

describe("GoalWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.removeItem("marshal.panel.goal.max-height");
    window.localStorage.removeItem("marshal.panel.goal.max-height");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  });

  it("requires the canonical goal authority", () => {
    expect(() =>
      getGoalSnapshotView({
        sessionId: "s1",
        goal: null,
        fence: null,
      }),
    ).toThrow("goal authority is missing");
  });

  it("renders nothing when there is no runtime snapshot", async () => {
    renderWidget(null);
    await waitFor(() => expect(screen.queryByTestId("goal-widget")).toBeNull());
  });

  it("shows a recovery notice for a quarantined unreadable goal without inventing one", async () => {
    renderWidget({
      sessionId: "s1",
      goal: null,
      fence: null,
      recovery: {
        reason: "invalid-document",
        quarantinedAt: "2026-09-11T09:00:00.000Z",
        rawBytes: 512,
      },
    });
    const notice = await screen.findByTestId("goal-recovery-notice");
    expect(notice).toHaveTextContent("Saved goal couldn't be read");
    expect(notice).toHaveTextContent("/goal <objective>");
    expect(screen.queryByTestId("goal-widget")).toBeNull();
  });

  it.each([
    ["pursuing", "Pursuing goal"],
    ["paused", "Paused"],
    ["blocked", "Blocked"],
    ["completed", "Completed"],
    ["stopped", "Stopped"],
  ] satisfies [GoalStatus, string][])("renders the %s status", async (status, label) => {
    renderWidget(makeSnapshot({ status }));
    expect(await screen.findByTestId("goal-status-label")).toHaveTextContent(label);
  });

  it("shows the complete minimal goal record", async () => {
    renderWidget(
      makeSnapshot({
        status: "blocked",
        blockedReason: "Choose a deployment region",
        criteria: ["Unit tests pass", "Docs updated"],
        progress: ["Implemented the renderer migration"],
        openQuestions: ["Which region should be used?"],
        assumptions: ["The API contract is stable"],
        decisions: ["Keep steering available while blocked"],
        state: { retryCount: 2, target: "desktop" },
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("goal-expand"));

    expect(screen.getByTestId("goal-objective")).toHaveTextContent("Ship onboarding cleanup");
    expect(screen.getByTestId("goal-criteria")).toHaveTextContent("Unit tests pass");
    expect(screen.getByTestId("goal-progress")).toHaveTextContent(
      "Implemented the renderer migration",
    );
    expect(screen.getByTestId("goal-questions")).toHaveTextContent("Which region should be used?");
    expect(screen.getByTestId("goal-assumptions")).toHaveTextContent("The API contract is stable");
    expect(screen.getByTestId("goal-decisions")).toHaveTextContent(
      "Keep steering available while blocked",
    );
    expect(screen.getByTestId("goal-state")).toHaveTextContent('"retryCount": 2');
    expect(screen.getByTestId("goal-blocked-reason")).toHaveTextContent(
      "Choose a deployment region",
    );
    expect(screen.getByTestId("goal-stats")).toHaveTextContent(
      "4.2K tokens · 3 turns · about 5 seconds",
    );
  });

  it("bounds deeply nested and oversized state before rendering it", () => {
    const view = getGoalSnapshotView(
      makeSnapshot({
        state: {
          oversized: "x".repeat(10_000),
          nested: { one: { two: { three: { four: { five: "hidden" } } } } },
          many: Array.from({ length: 100 }, (_, index) => index),
        },
      }),
    );
    const wideView = getGoalSnapshotView(
      makeSnapshot({ state: { ["key".repeat(10_000)]: "bounded" } }),
    );

    expect(view.stateJson).not.toContain("x".repeat(1_000));
    expect(view.stateJson).toContain("…");
    expect(view.stateJson).toContain("[truncated]");
    expect(view.stateJson!.length).toBeLessThanOrEqual(8_192);
    expect(wideView.stateJson!.length).toBeLessThanOrEqual(8_192);
  });

  it("updates objective and acceptance criteria through updateDefinition", async () => {
    const updated = makeSnapshot({
      objective: "New objective",
      criteria: ["Tests pass", "Docs pass"],
    });
    const updateDefinition = vi.fn<GoalAPI["updateDefinition"]>().mockResolvedValue(ok(updated));
    renderWidget(makeSnapshot({ criteria: ["Tests pass"] }), { updateDefinition });
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("goal-edit"));
    const objective = screen.getByTestId("goal-edit-input");
    await user.clear(objective);
    await user.type(objective, "New objective");
    await user.click(screen.getByTestId("goal-edit-add-criterion"));
    await user.type(screen.getByLabelText("Criterion 2"), "Docs pass");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateDefinition).toHaveBeenCalledWith("s1", {
        expectedFence: fence,
        patch: {
          objective: "New objective",
          criteria: ["Tests pass", "Docs pass"],
        },
      }),
    );
  });

  it("pauses, resumes, stops, and steers through the minimal controls", async () => {
    const user = userEvent.setup();
    const pause = vi
      .fn<GoalAPI["pause"]>()
      .mockResolvedValue(ok(makeSnapshot({ status: "paused" })));
    const { unmount: unmountPaused } = renderWidget(makeSnapshot(), { pause });
    await user.click(await screen.findByTestId("goal-pause"));
    await waitFor(() => expect(pause).toHaveBeenCalledWith("s1", fence));
    unmountPaused();

    const resume = vi.fn<GoalAPI["resume"]>().mockResolvedValue(ok());
    const { unmount: unmountResumed } = renderWidget(makeSnapshot({ status: "paused" }), {
      resume,
    });
    await user.click(await screen.findByTestId("goal-resume"));
    await waitFor(() => expect(resume).toHaveBeenCalledWith("s1", fence));
    unmountResumed();

    const steer = vi.fn<GoalAPI["steer"]>().mockResolvedValue(ok());
    const { unmount: unmountSteered } = renderWidget(makeSnapshot(), { steer });
    await user.click(await screen.findByTestId("goal-expand"));
    await user.type(screen.getByLabelText("Steer goal"), "Focus on accessibility");
    await user.click(screen.getByRole("button", { name: "Apply goal steering" }));
    await waitFor(() =>
      expect(steer).toHaveBeenCalledWith("s1", {
        expectedFence: fence,
        instruction: "Focus on accessibility",
      }),
    );
    unmountSteered();

    const stop = vi
      .fn<GoalAPI["stop"]>()
      .mockResolvedValue(ok(makeSnapshot({ status: "stopped" })));
    renderWidget(makeSnapshot(), { stop });
    await user.click(await screen.findByTestId("goal-stop"));
    expect(screen.getByTestId("confirm-stop-goal-dialog")).toHaveTextContent("Stop this goal?");
    await user.click(screen.getByTestId("confirm-stop-goal"));
    await waitFor(() => expect(stop).toHaveBeenCalledWith("s1", fence));
  });
});
