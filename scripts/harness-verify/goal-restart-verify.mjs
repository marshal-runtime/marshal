/**
 * Production-wiring restart verification for goal auto-resume (R1).
 *
 * Seeds an isolated profile whose persisted session already carries a
 * schema-v3 `pursuing` goal (simulating an app that was closed mid-pursuit),
 * launches the REAL app binary (production main.ts — whenReady ordering,
 * startup auth gate, engine wiring), and asserts, without any manual
 * resume/start IPC call:
 *
 *   1. the goal is never flipped to `paused` and never gains a
 *      "paused after restart" progress note (the audit's false-pause bug);
 *   2. the engine autonomously attempted pursuit — observable as a growing
 *      continuationCount or a persisted goal-continuation exchange.
 *
 * Runs entirely against an isolated MARSHAL_E2E data dir + user-data-dir;
 * never touches the live host or store.
 *
 * Usage (from repo root, after `pnpm build:vite`):
 *   node scripts/harness-verify/goal-restart-verify.mjs
 * Env: PORT (default 9345), WORKER (default goal-restart-verify),
 *      RESUME_TIMEOUT_MS (default 120000).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { connectToApp, invokeIPC, waitForReady } from "./cdp-helpers.mjs";

const PORT = Number(process.env.PORT || 9345);
const WORKER = process.env.WORKER || "goal-restart-verify";
const RESUME_TIMEOUT_MS = Number(process.env.RESUME_TIMEOUT_MS || 120_000);
const SESSION_ID = "goal-harness-seed";

const log = (...args) => console.log("[goal-restart-verify]", ...args);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function seedProfile() {
  execFileSync("node", ["scripts/harness-verify/seed-isolated.mjs"], {
    env: { ...process.env, MARSHAL_E2E_WORKER: WORKER },
    stdio: "inherit",
  });
  const dataDir = path.join(os.tmpdir(), `marshal-e2e-data-${WORKER}`);
  const sessionPath = path.join(dataDir, "marshal-sessions", `${SESSION_ID}.json`);
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  const now = new Date().toISOString();
  // The user's instruction the goal was created from — sourceInstruction
  // provenance is exercised by the seeded message.
  session.messages = [
    {
      id: "seed-user-instruction",
      role: "user",
      content: "Keep summarizing the fixture repository until every module is described.",
      timestamp: now,
    },
  ];
  session.goal = {
    schemaVersion: 3,
    id: "restart-goal-1",
    epoch: 1,
    objective: "Summarize every module in the fixture repository",
    criteria: ["Every module has a one-paragraph summary"],
    sourceInstruction: {
      messageId: "seed-user-instruction",
      excerpt: "Keep summarizing the fixture repository until every module is described.",
    },
    status: "pursuing",
    createdAt: now,
    updatedAt: now,
    startedPursuingAt: now,
    progress: [],
    openQuestions: [],
    assumptions: [],
    decisions: [],
    state: {},
    continuationCount: 0,
    activeMs: 0,
    tokensUsed: 0,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  log(`Seeded pursuing goal into ${sessionPath}`);
  return { dataDir, sessionPath };
}

function launchApp(dataDir) {
  const electronBin = path.join("node_modules", ".bin", "electron");
  const child = spawn(
    electronBin,
    [
      ".",
      "--no-sandbox",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${path.join(dataDir, "electron-user-data")}`,
    ],
    {
      env: {
        ...process.env,
        MARSHAL_E2E: "1",
        MARSHAL_GOAL_HARNESS: "1",
        MARSHAL_E2E_WORKSPACE_FIXTURES: "1",
        MARSHAL_E2E_WORKER: WORKER,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => process.stdout.write(`[app] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[app] ${chunk}`));
  log(`Launched isolated app pid=${child.pid} port=${PORT}`);
  return child;
}

// The session store encrypts persisted files once the app owns them, so all
// runtime evidence comes through the real preload IPC instead of file reads.
async function continuationEvidence(Runtime, goal) {
  if (goal.continuationCount > 0) return `continuationCount=${goal.continuationCount}`;
  if (goal.tokensUsed > 0) return `tokensUsed=${goal.tokensUsed}`;
  // A dispatched continuation persists a hidden goal-continuation user turn
  // in the transcript; the messages API is the same one the renderer uses.
  const messages = await invokeIPC(Runtime, "sessionsAPI", "getMessages", SESSION_ID).catch(
    () => null,
  );
  const list = Array.isArray(messages) ? messages : (messages?.messages ?? []);
  const hit = list.find(
    (message) =>
      message?.goalContinuation === true ||
      message?.internalControl?.kind === "goal-continuation" ||
      message?.goalTimelineEvent?.type === "goal.continuation",
  );
  return hit ? `persisted goal-continuation message ${hit.id}` : null;
}

async function main() {
  const { dataDir, sessionPath } = seedProfile();
  const app = launchApp(dataDir);
  const finish = (code) => {
    try {
      app.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    process.exit(code);
  };
  try {
    const { Runtime } = await connectToApp(PORT);
    await waitForReady(Runtime, 60_000);
    log("Renderer ready; observing goal without any manual resume call");

    const deadline = Date.now() + RESUME_TIMEOUT_MS;
    let lastSnapshot = null;
    let resumed = false;
    while (Date.now() < deadline) {
      const response = await invokeIPC(Runtime, "goalAPI", "get", SESSION_ID);
      assert(response?.success, `goalAPI.get failed: ${response?.error}`);
      const goal = response.snapshot?.goal;
      assert(goal, "seeded goal disappeared from the runtime snapshot");
      lastSnapshot = goal;

      // Regression assertion: boot/navigation must never convert the
      // persisted pursuing goal into a pause.
      assert(
        goal.status !== "paused",
        `goal was paused by startup (progress: ${JSON.stringify(goal.progress)})`,
      );
      assert(
        !goal.progress.some((entry) => /paused after restart/i.test(entry)),
        "goal gained a 'paused after restart' note",
      );

      const evidence = await continuationEvidence(Runtime, goal);
      if (evidence) {
        log(`Autonomous continuation evidence: ${evidence}`);
        resumed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    log(
      `Final observation: status=${lastSnapshot?.status} continuationCount=${lastSnapshot?.continuationCount} ` +
        `blockedReason=${JSON.stringify(lastSnapshot?.blockedReason ?? null)}`,
    );
    assert(
      resumed,
      `no autonomous continuation observed within ${RESUME_TIMEOUT_MS}ms — ` +
        `status=${lastSnapshot?.status}, continuationCount=${lastSnapshot?.continuationCount}`,
    );
    log("PASS: persisted pursuing goal auto-resumed through production startup wiring");

    // Durable-state check through the same store the app persists to (files
    // are encrypted at rest, so read via IPC before quitting).
    const finalSnapshot = await invokeIPC(Runtime, "goalAPI", "get", SESSION_ID);
    const finalGoal = finalSnapshot?.snapshot?.goal;
    assert(finalGoal && finalGoal.status !== "paused", "goal ended paused after the run");
    log(`PASS: durable goal at end of run: status=${finalGoal.status}`);
    finish(0);
  } catch (error) {
    console.error("[goal-restart-verify] FAIL:", error);
    finish(1);
  }
}

await main();
