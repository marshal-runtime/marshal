/**
 * Isolated smoke for the current goal preload API.
 *
 * Launch with MARSHAL_E2E=1, MARSHAL_GOAL_HARNESS=1, and
 * MARSHAL_E2E_WORKSPACE_FIXTURES=1 after seeding the same worker.
 */
import fs from "node:fs";

import { connectToApp, evaluate, invokeIPC, screenshot, waitForReady } from "./cdp-helpers.mjs";

const PORT = Number(process.env.PORT || 9337);
const OUT = process.env.OUT || "goal-verify.json";
const RESULTS_DIR = process.env.RESULTS_DIR || ".";
const WORKSPACE_NAME = process.env.WORKSPACE_NAME || "ExternalProject";
const VERIFY_SESSION_ID = process.env.VERIFY_SESSION_ID || "";
const QUIT_AFTER = process.env.QUIT_AFTER === "1";

const log = (...args) => console.log("[goal-verify]", ...args);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertFence(fence, label) {
  assert(fence && typeof fence === "object", `${label} has no fence`);
  assert(
    Object.keys(fence).sort().join(",") === "epoch,goalId",
    `${label} fence is not exactly { goalId, epoch }: ${JSON.stringify(fence)}`,
  );
  assert(typeof fence.goalId === "string" && fence.goalId.length > 0, `${label} goalId is invalid`);
  assert(Number.isSafeInteger(fence.epoch) && fence.epoch > 0, `${label} epoch is invalid`);
}

function assertSnapshot(snapshot, sessionId, label) {
  assert(snapshot?.sessionId === sessionId, `${label} has the wrong session`);
  assert(snapshot.goal && snapshot.goal.schemaVersion === 3, `${label} has no schema-v3 goal`);
  assert(snapshot.goal.id === snapshot.fence?.goalId, `${label} goal and fence IDs differ`);
  assert(snapshot.goal.epoch === snapshot.fence?.epoch, `${label} goal and fence epochs differ`);
  assertFence(snapshot.fence, label);
  for (const field of ["criteria", "progress", "openQuestions", "assumptions", "decisions"]) {
    assert(Array.isArray(snapshot.goal[field]), `${label} goal.${field} is not an array`);
  }
  assert(
    snapshot.goal.state && typeof snapshot.goal.state === "object",
    `${label} goal.state is invalid`,
  );
  for (const removed of [
    "pendingReview",
    "reviewerFeedback",
    "finalDelivery",
    "memory",
    "blockedKind",
  ]) {
    assert(!(removed in snapshot.goal), `${label} retained removed goal field ${removed}`);
  }
  assert(!("phase" in snapshot), `${label} retained synthetic runtime phase`);
  return snapshot;
}

async function expectGoalResponse(Runtime, method, sessionId, ...args) {
  const response = await invokeIPC(Runtime, "goalAPI", method, sessionId, ...args);
  assert(response?.success, `goalAPI.${method} failed: ${response?.error ?? "unknown error"}`);
  return assertSnapshot(response.snapshot, sessionId, `goalAPI.${method}`);
}

async function installEventCapture(Runtime) {
  await evaluate(
    Runtime,
    `(() => {
      window.__goalHarnessEvents = [];
      window.__disposeGoalHarnessEvents?.();
      window.__disposeGoalHarnessEvents = window.goalAPI.onChanged((event) => {
        window.__goalHarnessEvents.push(event);
      });
      return true;
    })()`,
  );
}

async function createScopedMainSession(Runtime) {
  const workspaceList = await invokeIPC(Runtime, "workspaceAPI", "listWorkspaces");
  assert(workspaceList?.success, `workspace list failed: ${workspaceList?.error}`);
  const binding = workspaceList.workspaceBindings?.find(
    (candidate) => candidate.name === WORKSPACE_NAME,
  );
  assert(binding, `workspace binding "${WORKSPACE_NAME}" was not returned`);

  const repositoryAgents = await invokeIPC(
    Runtime,
    "workspaceAPI",
    "listRepositoryAgents",
    WORKSPACE_NAME,
  );
  assert(repositoryAgents?.success, `repository-agent list failed: ${repositoryAgents?.error}`);
  const repositoryAgent = repositoryAgents.agents?.[0];
  assert(repositoryAgent?.identity, `repository agent identity for "${WORKSPACE_NAME}" is missing`);

  const created = await evaluate(
    Runtime,
    `window.sessionsAPI.createMain(
      undefined,
      undefined,
      ${JSON.stringify({ workspaceBinding: binding, repositoryAgent })}
    )`,
  );
  assert(created?.success && created.session?.id, `session create failed: ${created?.error}`);
  return { session: created.session, workspaceList, repositoryAgents };
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const result = { port: PORT, workspaceName: WORKSPACE_NAME, steps: {}, ok: false };
  const connection = await connectToApp(PORT);
  const { Runtime, Page } = connection;

  try {
    await waitForReady(Runtime);
    await installEventCapture(Runtime);

    if (VERIFY_SESSION_ID) {
      const persisted = await expectGoalResponse(Runtime, "get", VERIFY_SESSION_ID);
      assert(persisted.goal.status === "stopped", "restarted goal did not retain stopped status");
      assert(
        persisted.goal.state.harnessStep === "context-updated",
        "restarted goal did not retain generic state",
      );
      assert(
        persisted.goal.progress.includes("Created, paused, and updated the goal through preload IPC"),
        "restarted goal did not retain progress text",
      );
      result.steps.sessionId = VERIFY_SESSION_ID;
      result.steps.restartPersistence = persisted;
      result.ok = true;
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
      log("RESTART PERSISTENCE PASSED ->", OUT);
      return;
    }

    const created = await createScopedMainSession(Runtime);
    const sessionId = created.session.id;
    result.steps.workspaceList = created.workspaceList;
    result.steps.repositoryAgents = created.repositoryAgents;
    result.steps.sessionId = sessionId;

    let snapshot = await expectGoalResponse(Runtime, "set", sessionId, {
      objective: "Verify the compact goal API",
      criteria: ["All current preload mutations preserve the minimal contract"],
    });
    result.steps.set = snapshot;
    assert(snapshot.goal.status === "pursuing", "new goal is not pursuing");
    const creationFence = snapshot.fence;

    snapshot = await expectGoalResponse(Runtime, "pause", sessionId, snapshot.fence);
    result.steps.pause = snapshot;
    assert(snapshot.goal.status === "paused", "goal did not pause");
    assert(snapshot.fence.epoch > creationFence.epoch, "pause did not advance the epoch");

    snapshot = await expectGoalResponse(Runtime, "updateDefinition", sessionId, {
      expectedFence: snapshot.fence,
      patch: {
        objective: "Verify and persist the compact goal API",
        criteria: ["Every current preload mutation returns a schema-v3 snapshot"],
      },
    });
    result.steps.updateDefinition = snapshot;
    assert(snapshot.goal.criteria.length === 1, "definition update did not replace criteria");

    const stale = await invokeIPC(Runtime, "goalAPI", "updateContext", sessionId, {
      expectedFence: creationFence,
      patch: { progress: ["This stale write must not persist"] },
    });
    result.steps.staleMutation = stale;
    assert(stale?.success === false, "stale goal mutation unexpectedly succeeded");

    const contextFence = snapshot.fence;
    snapshot = await expectGoalResponse(Runtime, "updateContext", sessionId, {
      expectedFence: contextFence,
      patch: {
        progress: ["Created, paused, and updated the goal through preload IPC"],
        assumptions: ["The isolated E2E session store is authoritative"],
        decisions: ["Use only the compact goalAPI surface"],
        state: { set: { harnessStep: "context-updated" } },
      },
    });
    result.steps.updateContext = snapshot;
    assert(snapshot.fence.epoch === contextFence.epoch, "context update changed goal authority");
    assert(
      snapshot.goal.state.harnessStep === "context-updated",
      "context state was not persisted",
    );

    const beforeCompact = snapshot;
    const compacted = await invokeIPC(Runtime, "sessionsAPI", "compact", sessionId);
    result.steps.compact = compacted;
    assert(compacted?.success, `same-session compact failed: ${compacted?.error ?? "unknown error"}`);
    snapshot = await expectGoalResponse(Runtime, "get", sessionId);
    result.steps.afterCompact = snapshot;
    assert(snapshot.goal.id === beforeCompact.goal.id, "compact replaced the goal");
    assert(snapshot.fence.epoch === beforeCompact.fence.epoch, "compact changed goal authority");
    assert(
      snapshot.goal.state.harnessStep === "context-updated",
      "compact lost generic goal state",
    );

    snapshot = await expectGoalResponse(Runtime, "resume", sessionId, snapshot.fence);
    result.steps.resume = snapshot;
    assert(snapshot.goal.status === "pursuing", "goal did not resume");

    snapshot = await expectGoalResponse(Runtime, "steer", sessionId, {
      expectedFence: snapshot.fence,
      instruction: "Finish the boundary smoke without adding compatibility fields.",
    });
    result.steps.steer = snapshot;
    assert(
      snapshot.goal.decisions.some((decision) => decision.includes("User steering:")),
      "steering was not recorded",
    );

    snapshot = await expectGoalResponse(Runtime, "stop", sessionId, snapshot.fence);
    result.steps.stop = snapshot;
    assert(snapshot.goal.status === "stopped", "goal did not stop");

    const reloaded = await expectGoalResponse(Runtime, "get", sessionId);
    result.steps.sameProcessReload = reloaded;
    assert(reloaded.goal.status === "stopped", "stopped goal was not durable");
    assert(reloaded.fence.epoch === snapshot.fence.epoch, "reloaded fence changed");

    const events = await evaluate(
      Runtime,
      `window.__goalHarnessEvents.map((event) => ({
        sessionId: event.sessionId,
        status: event.snapshot?.goal?.status ?? null,
        fence: event.snapshot?.fence ?? null
      }))`,
    );
    result.steps.goalChangedEvents = events;
    assert(events.length >= 6, "expected goal:changed events were not emitted");
    for (const [index, event] of events.entries()) {
      assert(event.sessionId === sessionId, `event ${index} has the wrong session`);
      assertFence(event.fence, `event ${index}`);
    }
    assert(
      events.some((event) => event.status === "stopped"),
      "stopped event was not emitted",
    );

    result.steps.screenshot = await screenshot(Page, RESULTS_DIR, "goal-harness-runtime.png");
    result.ok = true;
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    log("SMOKE PASSED ->", OUT);
  } finally {
    if (QUIT_AFTER) {
      await invokeIPC(Runtime, "shellAPI", "quitApp").catch(() => {});
    }
    await connection.client.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("[goal-verify] crashed:", error.stack || error.message);
  process.exit(1);
});
