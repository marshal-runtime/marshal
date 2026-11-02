#!/usr/bin/env node
// L2-005 HONEST-RED/GREEN capture (L2-found / parent-relayed — planner-triaged).
//
// On the v2 facility ref (55b8230e9) with an explicit port, endpoint
// verification, pinned integrity, and applicationId supplied, identify-
// installed-artifact.mjs's live installed-api receipt reported
// matchedInstance:null even with the target pane visibly open (receipt:
// verification/l2/l2-1-identify-code-review-v2-facility.json). Root cause:
// discoverLiveScope() picked exactly ONE scope — the active, else the first,
// open session — and assumed that session's own workspace owned every open
// application instance. runtime-ui:getSnapshot(scope) filters instances by
// that exact {sessionId, workspaceName} pair
// (electron/marshal-runtime/ui-controller.ts's scopedInstances()/sameScope()),
// so an auto-picked scope that does not own the open instance always reports
// matchedInstance:null, no matter how confidently the pane is open elsewhere.
//
// Produces:
//   test-receipts/l2005-red.txt   — the unmodified 55b8230e9 behavior
//     (selectLiveScope() alone, still exported byte-identical by this repair
//     — see lib/live-scope-discovery.mjs's doc comment) applied to a fixture
//     where the target instance is open under a session/workspace that is
//     NOT the active/first one: reproduces matchedInstance:null.
//   test-receipts/l2005-green.txt — the CURRENT (post-repair)
//     selectScopeForIdentify() decision: (a) correct auto-selection of the
//     single session that actually owns the instance, (b) an operator-pinned
//     scopeOverride selecting deterministically, (c) a typed refusal when the
//     override is unresolvable, (d) a typed refusal listing every candidate
//     when more than one open session owns the instance and no override was
//     supplied to disambiguate.
//
// Re-runnable on demand; not part of run-all.mjs's offline pipeline (no live
// Marshal is involved — it is a fixture-shaped, deterministic reproduction).
// Permanent fast regression coverage of the same decision logic lives in
// lib/live-scope-discovery.test.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selectLiveScope, selectScopeForIdentify } from "../lib/live-scope-discovery.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.resolve(__dirname, "..", "test-receipts");

// The live shape: the operator's target application, open under a session
// whose workspace the active/first-session heuristic would never pick.
const TARGET = { identity: "@marshal/code-review", applicationId: "codereview.prs" };
const SESSIONS = {
  success: true,
  sessions: [
    { id: "session-1", workspaceName: "marshal-host", isActive: true },
    { id: "session-2", workspaceName: "codereview-workspace", isActive: false },
  ],
};
const MATCHING_INSTANCE = {
  instanceId: "instance-1",
  surface: "panel",
  owner: { extensionId: TARGET.identity, applicationId: TARGET.applicationId },
};
const INSTANCES_BY_SCOPE = {
  "session-1::marshal-host": [],
  "session-2::codereview-workspace": [MATCHING_INSTANCE],
};

function findInstance(instances, target) {
  return (
    instances.find(
      (instance) =>
        instance?.owner?.extensionId === target.identity &&
        instance?.owner?.applicationId === target.applicationId,
    ) ?? null
  );
}

async function captureRed() {
  const lines = [
    "=== L2-005 RED: unmodified 55b8230e9 discovery (selectLiveScope alone) against a fixture where the " +
      "target instance is open under a NON-auto-picked session ===",
    "",
    `Fixture sessions: ${JSON.stringify(SESSIONS.sessions)}`,
    `Fixture instances by scope: ${JSON.stringify(INSTANCES_BY_SCOPE)}`,
    `Target: ${JSON.stringify(TARGET)}`,
    "",
    "Calling selectLiveScope(sessionsListResponse) — the ONLY discovery function that existed at " +
      "55b8230e9, still exported byte-identical by this repair (kept as the legacy no-application-target " +
      "fallback; see lib/live-scope-discovery.mjs's doc comment) — this is the exact pre-repair pipeline, " +
      "not a strawman reconstruction.",
  ];
  const scope = selectLiveScope(SESSIONS);
  lines.push(`Result: ${JSON.stringify(scope)}`);
  lines.push(
    "This is the active session (session-1, workspace marshal-host) — the pre-repair heuristic always " +
      "picks it regardless of where the target's pane is actually open.",
  );
  const instances = INSTANCES_BY_SCOPE[`${scope.sessionId}::${scope.workspaceName}`] ?? [];
  const matchedInstance = findInstance(instances, TARGET);
  lines.push(
    `Simulating identify-installed-artifact.mjs's matchedInstance lookup against that scope's own ` +
      `runtime-ui:getSnapshot instances (${JSON.stringify(instances)}): matchedInstance = ` +
      `${JSON.stringify(matchedInstance)}`,
  );
  const ok = matchedInstance === null;
  lines.push(
    ok
      ? "REPRODUCED: matchedInstance is null even though the target's pane IS open (under session-2's " +
          "workspace, codereview-workspace) — the exact live defect (verification/l2/" +
          "l2-1-identify-code-review-v2-facility.json)."
      : "FAIL: expected the unrepaired heuristic to miss the instance.",
  );
  return { lines, ok };
}

async function captureGreenSingleCandidate() {
  const lines = [
    "=== L2-005 GREEN (a): correct auto-selection of the single session that actually owns the open instance ===",
    "",
  ];
  const result = selectScopeForIdentify({
    sessionsListResponse: SESSIONS,
    instancesByScope: INSTANCES_BY_SCOPE,
    target: TARGET,
  });
  lines.push(
    `Calling selectScopeForIdentify() with the SAME fixture as the red reproduction above...`,
  );
  lines.push(`Result: ${JSON.stringify(result)}`);
  const ok =
    result.ok === true &&
    result.matchedVia === "single-instance-candidate" &&
    result.scope?.sessionId === "session-2" &&
    result.scope?.workspaceName === "codereview-workspace";
  lines.push(
    ok
      ? "session-2 (codereview-workspace) is selected — NOT the active/first session-1 — because it is " +
          "the only open session whose own runtime-ui:getSnapshot instances actually own the target " +
          "application. The identity+integrity+publication+declaredActions+viewport gates can now run " +
          "against the real open instance."
      : "FAIL: expected the single instance-owning session to be selected.",
  );
  return { lines, ok };
}

async function captureGreenOverride() {
  const lines = [
    "=== L2-005 GREEN (b): an operator-pinned scopeOverride selects deterministically ===",
    "",
  ];
  const result = selectScopeForIdentify({
    sessionsListResponse: SESSIONS,
    override: { workspaceName: "codereview-workspace" },
    instancesByScope: {}, // deliberately empty — an override is trusted directly, never cross-checked
    target: TARGET,
  });
  lines.push(
    'Calling selectScopeForIdentify() with scopeOverride={"workspaceName":"codereview-workspace"} and an ' +
      "EMPTY instancesByScope (proving the override is trusted directly, not re-derived from instance " +
      "search)...",
  );
  lines.push(`Result: ${JSON.stringify(result)}`);
  const ok =
    result.ok === true &&
    result.matchedVia === "override" &&
    result.scope?.sessionId === "session-2" &&
    result.scope?.workspaceName === "codereview-workspace";
  lines.push(
    ok
      ? "session-2 selected via the pinned override, bypassing automatic candidate search entirely."
      : "FAIL: expected the override to resolve to session-2.",
  );
  return { lines, ok };
}

async function captureGreenUnresolvableOverride() {
  const lines = [
    "=== L2-005 GREEN (c): an unresolvable scopeOverride is a typed refusal, never a silent fallback ===",
    "",
  ];
  const result = selectScopeForIdentify({
    sessionsListResponse: SESSIONS,
    override: { workspaceName: "nonexistent-workspace" },
    instancesByScope: INSTANCES_BY_SCOPE,
    target: TARGET,
  });
  lines.push(
    'Calling selectScopeForIdentify() with scopeOverride={"workspaceName":"nonexistent-workspace"} (no ' +
      "open session has this workspace)...",
  );
  lines.push(`Result: ${JSON.stringify(result)}`);
  const ok = result.ok === false && result.code === "scope-override-unresolvable";
  lines.push(
    ok
      ? "REFUSED with code scope-override-unresolvable — the facility does NOT silently fall back to " +
          "auto-discovery when the operator's pin doesn't resolve."
      : "FAIL: expected an unresolvable override to refuse, not fall back.",
  );
  return { lines, ok };
}

async function captureGreenMultiCandidateRefusal() {
  const lines = [
    "=== L2-005 GREEN (d): multiple open sessions owning the instance with no override is a typed refusal listing the candidates ===",
    "",
  ];
  const multiCandidateSessions = {
    success: true,
    sessions: [
      { id: "session-1", workspaceName: "marshal-host", isActive: true },
      { id: "session-2", workspaceName: "codereview-workspace", isActive: false },
      { id: "session-3", workspaceName: "another-workspace", isActive: false },
    ],
  };
  const multiCandidateInstances = {
    "session-1::marshal-host": [],
    "session-2::codereview-workspace": [MATCHING_INSTANCE],
    "session-3::another-workspace": [MATCHING_INSTANCE],
  };
  lines.push(
    `Fixture: the target instance is open under BOTH session-2 and session-3 (e.g. two open panes of the ` +
      `same application across different sessions). No scopeOverride supplied.`,
  );
  const result = selectScopeForIdentify({
    sessionsListResponse: multiCandidateSessions,
    instancesByScope: multiCandidateInstances,
    target: TARGET,
  });
  lines.push(`Result: ${JSON.stringify(result)}`);
  const ok =
    result.ok === false &&
    result.code === "multi-candidate-no-override" &&
    Array.isArray(result.candidates) &&
    result.candidates.length === 2;
  lines.push(
    ok
      ? "REFUSED with code multi-candidate-no-override, listing both candidate sessions — the facility " +
          "never guesses which of two equally-plausible open instances the operator meant; it asks for a " +
          "scopeOverride to disambiguate instead."
      : "FAIL: expected a typed refusal listing exactly the two owning candidates.",
  );
  return { lines, ok };
}

function writeLines(fileName, sections) {
  const filePath = path.join(RECEIPTS_DIR, fileName);
  const body = sections.map(({ lines }) => lines.join("\n")).join("\n\n");
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
  fs.writeFileSync(filePath, `${body}\n`);
  return filePath;
}

async function main() {
  const red = await captureRed();
  const redPath = writeLines("l2005-red.txt", [red]);

  const greenA = await captureGreenSingleCandidate();
  const greenB = await captureGreenOverride();
  const greenC = await captureGreenUnresolvableOverride();
  const greenD = await captureGreenMultiCandidateRefusal();
  const greenPath = writeLines("l2005-green.txt", [greenA, greenB, greenC, greenD]);

  const summary = {
    redPath,
    greenPath,
    redOk: red.ok,
    greenOk: greenA.ok && greenB.ok && greenC.ok && greenD.ok,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = summary.redOk && summary.greenOk ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
