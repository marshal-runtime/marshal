// common/workflows-reducer.test.ts

import { describe, expect, it } from "vitest";

import type { WorkflowEvent } from "./workflows-contract";
import { isValidInvestigationCompletionTransition } from "./workflows-contract";
import { createInitialSnapshot, reduceRun, replaySnapshot } from "./workflows-reducer";

function event(seq: number, partial: Omit<WorkflowEvent, "seq" | "ts">): WorkflowEvent {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the test fixtures construct fully-typed payloads then cast back to the union
  return { seq, ts: 1_000_000 + seq, ...partial } as WorkflowEvent;
}

describe("workflows-reducer", () => {
  it("starts in 'pending' status with lastSeq=-1", () => {
    const s = createInitialSnapshot({ runId: "r1" });
    expect(s.status).toBe("pending");
    expect(s.events.lastSeq).toBe(-1);
    expect(s.steps).toEqual([]);
  });

  it("reduces run.started → running", () => {
    const s0 = createInitialSnapshot({ runId: "r1" });
    const s1 = reduceRun(
      s0,
      event(0, {
        type: "run.started",
        payload: {
          workflowId: "hello",
          workflowVersion: "1.0.0",
          workflowDistHash: "sha-aaa",
          runFamilyId: "r1",
          input: { name: "world" },
          startedAt: 1_000_000,
        },
      }),
    );
    expect(s1.status).toBe("running");
    expect(s1.workflowId).toBe("hello");
    expect(s1.workflowVersion).toBe("1.0.0");
    expect(s1.runFamilyId).toBe("r1");
    expect(s1.events.lastSeq).toBe(0);
  });

  it("upserts steps across started → completed", () => {
    const s = replaySnapshot({ runId: "r1" }, [
      event(0, {
        type: "run.started",
        payload: {
          workflowId: "x",
          workflowVersion: "1",
          workflowDistHash: "h",
          runFamilyId: "r1",
          input: {},
          startedAt: 0,
        },
      }),
      event(1, {
        type: "step.started",
        payload: {
          stepKey: "/0:greet",
          label: "greet",
          parentStepKey: "",
          startedAt: 100,
        },
      }),
      event(2, {
        type: "step.completed",
        payload: { stepKey: "/0:greet", label: "greet", result: "hi", durationMs: 50 },
      }),
    ]);
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]).toMatchObject({
      id: "/0:greet",
      status: "succeeded",
      result: "hi",
      durationMs: 50,
    });
  });

  it("captures agent spawn lifecycle", () => {
    const s = replaySnapshot({ runId: "r1" }, [
      event(0, {
        type: "agent.spawn-requested",
        payload: { handleId: "h1", stepKey: "/0:s", agentName: "reviewer" },
      }),
      event(1, {
        type: "agent.spawned",
        payload: { handleId: "h1", sessionId: "sess-1", agentName: "reviewer" },
      }),
      event(2, { type: "agent.spawn-complete", payload: { handleId: "h1", durationMs: 200 } }),
    ]);
    expect(s.agents.h1.status).toBe("completed");
    expect(s.agents.h1.sessionId).toBe("sess-1");
  });

  it("records artifacts in order", () => {
    const s = replaySnapshot({ runId: "r1" }, [
      event(0, {
        type: "artifact.saved",
        payload: {
          key: "summary.md",
          storageKey: "summary.md",
          namespace: "run",
          mime: "text/markdown",
          sizeBytes: 42,
        },
      }),
    ]);
    expect(s.artifacts).toHaveLength(1);
    expect(s.artifacts[0].key).toBe("summary.md");
  });

  it("reduces operational workflow events into the run snapshot", () => {
    const s = replaySnapshot({ runId: "r1" }, [
      event(0, {
        type: "schedule.cursor-advanced",
        payload: {
          key: "repo:incident",
          runId: "r1",
          next: { shiftId: "shift-a", coveredThrough: 1_000 },
        },
      }),
      event(1, {
        type: "stage.context-exposed",
        payload: {
          stageId: "bucketize",
          artifactFolders: [{ runId: "r1", prefix: "artifacts/fanout" }],
          artifacts: [],
          files: [{ path: "incidents.csv", reason: "incident input" }],
        },
      }),
      event(2, {
        type: "investigation.completion-transitioned",
        payload: {
          incidentId: "123",
          state: "agent_finished",
          chatLinks: [{ sessionId: "sess-1", runId: "r1" }],
          updatedAt: 1_002,
        },
      }),
      event(3, {
        type: "action-center.items-set",
        payload: {
          replace: true,
          items: [
            {
              id: "work-1",
              title: "File follow-up",
              why: "Incident has customer impact",
              evidence: [
                {
                  label: "Investigation",
                  artifacts: [],
                  chats: [{ sessionId: "sess-1" }],
                  files: [],
                },
              ],
              supportingDetails: ["Owner needs confirmation"],
              artifacts: [],
              chats: [{ sessionId: "sess-1" }],
            },
          ],
        },
      }),
    ]);

    expect(s.scheduleCursor).toMatchObject({ shiftId: "shift-a", coveredThrough: 1_000 });
    expect(s.stageContexts?.[0]).toMatchObject({ stageId: "bucketize" });
    expect(s.investigationCompletions?.["123"]).toMatchObject({ state: "agent_finished" });
    expect(s.actionCenterItems?.[0]).toMatchObject({
      id: "work-1",
      chats: [{ sessionId: "sess-1" }],
    });
  });

  it("enumerates investigation completion transitions", () => {
    expect(isValidInvestigationCompletionTransition(undefined, "pending_agent")).toBe(true);
    expect(isValidInvestigationCompletionTransition("pending_agent", "agent_finished")).toBe(true);
    expect(isValidInvestigationCompletionTransition("agent_finished", "approved")).toBe(true);
    expect(isValidInvestigationCompletionTransition("approved", "rejected")).toBe(false);
    expect(isValidInvestigationCompletionTransition("expired", "intervened")).toBe(true);
  });

  it("is idempotent under double-apply of the same event (lastSeq still updates)", () => {
    const ev = event(0, {
      type: "run.started",
      payload: {
        workflowId: "x",
        workflowVersion: "1",
        workflowDistHash: "h",
        runFamilyId: "r1",
        input: {},
        startedAt: 0,
      },
    });
    const s1 = reduceRun(createInitialSnapshot({ runId: "r1" }), ev);
    const s2 = reduceRun(s1, ev);
    expect(s2.status).toBe("running");
    expect(s2.events.lastSeq).toBe(0);
  });

  it("terminates on run.failed with errorSummary", () => {
    const s = replaySnapshot({ runId: "r1" }, [
      event(0, {
        type: "run.failed",
        payload: { error: { message: "boom" }, durationMs: 1 },
      }),
    ]);
    expect(s.status).toBe("failed");
    expect(s.errorSummary?.message).toBe("boom");
  });

  it("links a non-fanOut agent to its step via directAgents", () => {
    const s = replaySnapshot({ runId: "r1" }, [
      event(0, {
        type: "step.started",
        payload: { stepKey: "/0:collect", label: "collect", parentStepKey: "", startedAt: 0 },
      }),
      event(1, {
        type: "agent.spawn-requested",
        payload: { handleId: "c1", stepKey: "/0:collect", agentName: "collector" },
      }),
      event(2, {
        type: "agent.spawned",
        payload: {
          handleId: "c1",
          sessionId: "sess-c",
          agentName: "collector",
          stepKey: "/0:collect",
        },
      }),
    ]);
    const step = s.steps.find((st) => st.id === "/0:collect");
    expect(step?.kind).toBe("sequential");
    expect(step?.depth).toBe(0);
    expect(step?.directAgents).toEqual(["c1"]);
    expect(s.agents.c1.identity).toBe("collector");
    expect(s.agents.c1.sessionId).toBe("sess-c");
  });

  it("aggregates assistant turns and a message snippet onto the agent", () => {
    const s = replaySnapshot({ runId: "r1" }, [
      event(0, {
        type: "agent.spawn-requested",
        payload: { handleId: "a1", stepKey: "/0:s", agentName: "worker" },
      }),
      event(1, {
        type: "agent.spawned",
        payload: { handleId: "a1", sessionId: "sess-a", stepKey: "/0:s" },
      }),
      event(2, {
        type: "agent.message",
        payload: { handleId: "a1", role: "assistant", content: "  Found\nthe root cause  " },
      }),
    ]);
    expect(s.agents.a1.turnCount).toBe(1);
    expect(s.agents.a1.lastMessageSnippet).toBe("Found the root cause");
    expect(s.agents.a1.lastMessageAt).toBe(1_000_002);
  });

  it("builds fanOut units and links per-unit agents + artifacts", () => {
    const FAN = "/0:__fanOut";
    const U1 = "/0:__fanOut/0:[inc-1]";
    const s = replaySnapshot({ runId: "r1" }, [
      event(0, {
        type: "step.started",
        payload: { stepKey: FAN, label: "__fanOut", parentStepKey: "", startedAt: 0 },
      }),
      event(1, {
        type: "fanOut.started",
        payload: { stepKey: FAN, count: 2, itemKeys: ["inc-1", "inc-2"], maxConcurrency: 4 },
      }),
      event(2, {
        type: "step.started",
        payload: { stepKey: U1, label: "[inc-1]", parentStepKey: FAN, startedAt: 10 },
      }),
      event(3, {
        type: "agent.spawn-requested",
        payload: {
          handleId: "h1",
          stepKey: U1,
          agentName: "investigator",
          fanOutStepKey: FAN,
          fanOutUnitKey: "inc-1",
        },
      }),
      event(4, {
        type: "agent.spawned",
        payload: {
          handleId: "h1",
          sessionId: "sess-1",
          agentName: "investigator",
          stepKey: U1,
          fanOutStepKey: FAN,
          fanOutUnitKey: "inc-1",
        },
      }),
      event(5, {
        type: "artifact.saved",
        payload: {
          key: "investigation-inc-1.json",
          storageKey: "/runs/r1/investigation-inc-1.json",
          namespace: "fanout",
          mime: "application/json",
          sizeBytes: 10,
          stepKey: U1,
        },
      }),
      event(6, { type: "agent.spawn-complete", payload: { handleId: "h1", durationMs: 100 } }),
      event(7, {
        type: "fanOut.unit-completed",
        payload: { stepKey: FAN, itemKey: "inc-1" },
      }),
    ]);

    const fan = s.steps.find((st) => st.id === FAN);
    expect(fan?.kind).toBe("fanOut");
    expect(fan?.maxConcurrency).toBe(4);
    expect(fan?.units).toHaveLength(2);
    const unit1 = fan?.units?.find((u) => u.itemKey === "inc-1");
    expect(unit1).toMatchObject({
      handleId: "h1",
      sessionId: "sess-1",
      status: "succeeded",
    });
    expect(unit1?.startedAt).not.toBeNull();
    expect(unit1?.finishedAt).not.toBeNull();
    // The unit's inner step carries the agent + its artifact for drill-down.
    const unitStep = s.steps.find((st) => st.id === U1);
    expect(unitStep?.depth).toBe(1);
    expect(unitStep?.directAgents).toEqual(["h1"]);
    expect(unitStep?.artifacts).toEqual(["investigation-inc-1.json"]);
    // The untouched unit stays queued.
    expect(fan?.units?.find((u) => u.itemKey === "inc-2")?.status).toBe("queued");
    expect(s.agents.h1.status).toBe("completed");
  });
});
