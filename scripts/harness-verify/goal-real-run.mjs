/**
 * Real-backend probe for the compact goal architecture.
 *
 * Creates a fresh real-provider session and requires a composed continuation,
 * persisted owner work, a completion proposal, second-eyes approval, and
 * terminal outbox delivery before the deadline.
 */
import fs from "node:fs";
import path from "node:path";

import {
  connectToApp,
  evaluate,
  invokeIPC,
  screenshot,
  sleep,
  waitForReady,
} from "./cdp-helpers.mjs";

const PORT = Number(process.env.PORT || 9401);
const RESULTS_DIR = process.env.RESULTS_DIR || ".";
const MAX_MIN = Number(process.env.MAX_MIN || 10);

const OBJECTIVE = [
  "Calculate 17 multiplied by 19 without using repository, shell, browser, or runtime-search tools.",
  'Use goalUpdateContext to set state.calculation to {"expression":"17 * 19","result":323}, replace progress with a concise verification of the result, and record one decision.',
  "Then use goalProposeTransition with target completed and a concise final message.",
  "Do not merely describe the tool calls: invoke both goal tools.",
  "Do not invoke any tool except goalUpdateContext and goalProposeTransition.",
].join("\n");

const CRITERIA = [
  "state.calculation records the expression and result 323",
  "progress records a concrete verification of the calculation",
  "completion is proposed through goalProposeTransition and approved by the second-eyes reviewer",
];

const log = (...args) => console.log("[goal-real-run]", ...args);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertFence(fence, label) {
  assert(fence && typeof fence === "object", `${label} has no fence`);
  assert(
    Object.keys(fence).sort().join(",") === "epoch,goalId",
    `${label} fence is not exactly { goalId, epoch }`,
  );
}

async function approveVisiblePermission(Runtime) {
  return evaluate(
    Runtime,
    `(() => {
      const labels = ['Allow', 'Approve', 'Yes', 'Allow for session', 'Allow everywhere'];
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => labels.includes(candidate.textContent?.trim()));
      button?.click();
      return button?.textContent?.trim() ?? null;
    })()`,
  ).catch(() => null);
}

async function getSnapshot(Runtime, sessionId) {
  const response = await invokeIPC(Runtime, "goalAPI", "get", sessionId);
  assert(response?.success, `goalAPI.get failed: ${response?.error ?? "unknown error"}`);
  assert(response.snapshot?.goal?.schemaVersion === 3, "goalAPI.get returned no schema-v3 goal");
  assertFence(response.snapshot.fence, "goalAPI.get");
  return response.snapshot;
}

async function getMessages(Runtime, sessionId) {
  const response = await invokeIPC(Runtime, "sessionsAPI", "getMessages", sessionId, {
    limit: 500,
  });
  return Array.isArray(response) ? response : (response?.messages ?? []);
}

async function stopIfPursuing(Runtime, sessionId, snapshot) {
  if (snapshot?.goal?.status !== "pursuing") return snapshot;
  const response = await invokeIPC(Runtime, "goalAPI", "stop", sessionId, snapshot.fence);
  if (!response?.success) {
    log("cleanup stop failed:", response?.error ?? "unknown error");
    return snapshot;
  }
  return response.snapshot;
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const connection = await connectToApp(PORT);
  const { Runtime, Page } = connection;
  let sessionId;
  let snapshot;

  try {
    await waitForReady(Runtime, 60_000);
    await evaluate(
      Runtime,
      `(() => {
        window.__goalRealRunEvents = [];
        window.__disposeGoalRealRunEvents?.();
        window.__disposeGoalRealRunEvents = window.goalAPI.onChanged((event) => {
          window.__goalRealRunEvents.push(event);
        });
        return true;
      })()`,
    );

    const createdSession = await invokeIPC(Runtime, "sessionsAPI", "createMain");
    assert(
      createdSession?.success && createdSession.session?.id,
      `fresh session creation failed: ${createdSession?.error ?? "unknown error"}`,
    );
    sessionId = createdSession.session.id;
    await invokeIPC(Runtime, "sessionsAPI", "switch", sessionId);

    const createdGoal = await invokeIPC(Runtime, "goalAPI", "set", sessionId, {
      objective: OBJECTIVE,
      criteria: CRITERIA,
    });
    assert(createdGoal?.success, `goalAPI.set failed: ${createdGoal?.error ?? "unknown error"}`);
    snapshot = createdGoal.snapshot;
    assert(snapshot?.goal?.status === "pursuing", "new goal is not pursuing");
    assertFence(snapshot.fence, "goalAPI.set");

    const timeline = [];
    const deadline = Date.now() + MAX_MIN * 60_000;
    let observedContinuation = false;
    let observedWork = false;

    while (Date.now() < deadline) {
      await sleep(4_000);
      const approved = await approveVisiblePermission(Runtime);
      snapshot = await getSnapshot(Runtime, sessionId);
      const goal = snapshot.goal;
      const row = {
        observedAt: new Date().toISOString(),
        status: goal.status,
        epoch: goal.epoch,
        continuationCount: goal.continuationCount,
        progress: goal.progress,
        decisions: goal.decisions,
        openQuestions: goal.openQuestions,
        stateKeys: Object.keys(goal.state),
        approved,
      };
      timeline.push(row);
      log(
        `status=${row.status} epoch=${row.epoch} continuations=${row.continuationCount} progress=${row.progress.length}`,
      );

      observedContinuation ||= goal.continuationCount > 0;
      observedWork ||=
        goal.progress.length > 0 &&
        goal.decisions.length > 0 &&
        goal.state.calculation?.expression === "17 * 19" &&
        goal.state.calculation?.result === 323;
      if (goal.status !== "pursuing") break;
    }

    assert(
      observedContinuation,
      `no completed continuation was observed within ${MAX_MIN} minutes`,
    );
    assert(observedWork, "the driving agent did not persist the required work evidence");
    assert(
      snapshot.goal.status === "completed",
      `goal ended as ${snapshot.goal.status}, not reviewer-approved completed`,
    );

    const events = await evaluate(
      Runtime,
      `window.__goalRealRunEvents.map((event) => ({
        sessionId: event.sessionId,
        status: event.snapshot?.goal?.status ?? null,
        fence: event.snapshot?.fence ?? null
      }))`,
    );
    assert(events.length > 0, "no goal:changed event was observed");
    for (const [index, event] of events.entries()) assertFence(event.fence, `event ${index}`);

    let messages = await getMessages(Runtime, sessionId);
    const deliveryDeadline = Date.now() + 30_000;
    while (
      Date.now() < deliveryDeadline &&
      !messages.some(
        (message) =>
          message.agentMessage?.goalDeliveryKind === "terminal" &&
          message.agentMessage?.goalTerminalKind === "completed",
      )
    ) {
      await sleep(1_000);
      messages = await getMessages(Runtime, sessionId);
    }
    const continuationEvents = messages
      .map((message) => message.goalTimelineEvent)
      .filter((event) => event?.type === "goal.continuation");
    const continuationRequests = messages.filter(
      (message) =>
        message.internalControl?.kind === "goal-continuation" &&
        message.internalControl?.side === "request",
    );
    const continuationResponses = messages.filter(
      (message) =>
        message.internalControl?.kind === "goal-continuation" &&
        message.internalControl?.side === "response",
    );
    const toolCalls = messages.flatMap((message) => message.toolCalls ?? []);
    const contextUpdates = toolCalls.filter((call) => call.name === "goalUpdateContext");
    const completionProposals = toolCalls.filter((call) => call.name === "goalProposeTransition");
    const terminalMessages = messages.filter(
      (message) =>
        message.agentMessage?.goalDeliveryKind === "terminal" &&
        message.agentMessage?.goalTerminalKind === "completed",
    );

    assert(continuationEvents.length > 0, "no durable goal.continuation event was persisted");
    assert(continuationRequests.length > 0, "no hidden continuation prompt was persisted");
    assert(
      continuationResponses.length > 0,
      "no driving-agent continuation response was persisted",
    );
    assert(
      contextUpdates.some((call) => call.success !== false),
      "goalUpdateContext was not called successfully",
    );
    assert(
      completionProposals.some((call) => call.success !== false),
      "goalProposeTransition was not called successfully",
    );
    assert(terminalMessages.length > 0, "reviewed completion terminal delivery was not observed");

    const screenshotPath = await screenshot(Page, RESULTS_DIR, "goal-real-run.png");
    snapshot = await stopIfPursuing(Runtime, sessionId, snapshot);
    const output = {
      ok: true,
      sessionId,
      objective: OBJECTIVE,
      criteria: CRITERIA,
      timeline,
      events,
      continuationEvents,
      continuationRequests: continuationRequests.map((message) => ({
        id: message.id,
        exchangeId: message.internalControl.exchangeId,
        prompt: message.content,
      })),
      continuationResponses: continuationResponses.map((message) => ({
        id: message.id,
        exchangeId: message.internalControl.exchangeId,
        content: message.content,
      })),
      contextUpdates,
      completionProposals,
      terminalMessages: terminalMessages.map((message) => ({
        id: message.id,
        content: message.content,
        agentMessage: message.agentMessage,
      })),
      finalSnapshot: snapshot,
      screenshot: screenshotPath,
    };
    fs.writeFileSync(path.join(RESULTS_DIR, "goal-real-run.json"), JSON.stringify(output, null, 2));
    log("REAL GOAL PROBE PASSED");
  } finally {
    if (sessionId && snapshot) await stopIfPursuing(Runtime, sessionId, snapshot);
    await connection.client.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("[goal-real-run] crashed:", error.stack || error.message);
  process.exit(1);
});
