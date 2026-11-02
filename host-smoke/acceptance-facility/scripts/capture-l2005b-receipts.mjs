#!/usr/bin/env node
// L2-005 RESIDUAL (branch (ii), review-facility-tip / planner-routed) HONEST-RED/GREEN capture.
//
// review-facility-tip traced at source (d421db1ad + facility tip 23d5875e1): a NAV-OPENED pane
// instance registers under the PERSISTENT USER SCOPE {applicationScope:"user", workspaceName:"marshal"}
// (src/features/runtime-ui/RuntimeUiNavigation.tsx:60-67, common/runtime-ui.ts:251-254's
// RUNTIME_UI_USER_SCOPE) — owned by NO session. Every per-session-only enumeration at 23d5875e1
// (selectScopeForIdentify's candidate pool was session-shaped only) therefore reports
// matchedInstance:null even with the pane visibly open, exactly reproducing the parent's live rerun
// (verification/identify-l2005-live-scopefix-residual.json).
//
// Produces:
//   test-receipts/l2005b-red.txt   — the UNMODIFIED 23d5875e1 selectScopeForIdentify (extracted via
//     `git show 23d5875e1:...` and dynamically imported — the exact pre-repair code, not a
//     reconstruction) applied to a fixture where the target instance is open ONLY under the
//     persistent user scope: falls back to the legacy session heuristic and never finds it.
//   test-receipts/l2005b-green.txt — the CURRENT (post-repair) selectScopeForIdentify: (a) finds the
//     user-scope-only instance, (b) still finds a session-owned instance (no regression), (c) refuses
//     listing both when a session AND the persistent scope both own it, (d) an override pinning the
//     persistent scope works, (e) an unresolvable persistent-scope override refuses.
//
// Re-runnable on demand; not part of run-all.mjs's offline pipeline (no live Marshal is involved — it
// is a fixture-shaped, deterministic reproduction). Permanent fast regression coverage of the same
// decision logic lives in lib/live-scope-discovery.test.mjs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selectScopeForIdentify as selectScopeForIdentifyCurrent } from "../lib/live-scope-discovery.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RECEIPTS_DIR = path.resolve(__dirname, "..", "test-receipts");
const PRE_REPAIR_REF = "23d5875e1";
const FACILITY_MODULE_PATH = "host-smoke/acceptance-facility/lib/live-scope-discovery.mjs";

// The live shape: a nav-opened application instance, owned by the persistent user scope, with an
// ordinary open chat session present but NOT owning it.
const TARGET = { identity: "@marshal/code-review", applicationId: "codereview.prs" };
const SESSIONS = {
  success: true,
  sessions: [{ id: "session-1", workspaceName: "marshal-host", isActive: true }],
};
const MATCHING_INSTANCE = {
  instanceId: "instance-nav-1",
  surface: "tab",
  owner: { extensionId: TARGET.identity, applicationId: TARGET.applicationId },
};
const INSTANCES_USER_SCOPE_ONLY = {
  "session-1::marshal-host": [],
  "user::marshal": [MATCHING_INSTANCE],
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

/**
 * Extracts the EXACT pre-repair lib/live-scope-discovery.mjs content at 23d5875e1 via `git show` (no
 * network — a local git object read) and dynamically imports it, so the red reproduction runs the real
 * historical code rather than a hand-written reconstruction of it (same technique the L2-005 and
 * F-DEPLOY-2b reviews used to independently re-derive their red receipts).
 */
async function loadPreRepairModule() {
  const source = execFileSync("git", ["show", `${PRE_REPAIR_REF}:${FACILITY_MODULE_PATH}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const tmpFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "l2005b-pre-repair-")),
    "live-scope-discovery.pre-repair.mjs",
  );
  fs.writeFileSync(tmpFile, source);
  return import(`file://${tmpFile}`);
}

async function captureRed() {
  const preRepair = await loadPreRepairModule();
  const lines = [
    `=== L2-005 RESIDUAL RED: unmodified ${PRE_REPAIR_REF} selectScopeForIdentify (extracted via ` +
      "git show, not a reconstruction) against a fixture where the target instance is open ONLY under " +
      'the persistent user scope {applicationScope:"user", workspaceName:"marshal"} (nav-opened, ' +
      "owned by no session) ===",
    "",
    `Fixture sessions: ${JSON.stringify(SESSIONS.sessions)}`,
    `Fixture instances by scope: ${JSON.stringify(INSTANCES_USER_SCOPE_ONLY)}`,
    `Target: ${JSON.stringify(TARGET)}`,
    "",
    `Calling the ${PRE_REPAIR_REF} selectScopeForIdentify() — its candidate pool was session-shaped ` +
      "only, with no slot for a persistent scope...",
  ];
  const result = preRepair.selectScopeForIdentify({
    sessionsListResponse: SESSIONS,
    instancesByScope: INSTANCES_USER_SCOPE_ONLY,
    target: TARGET,
  });
  lines.push(`Result: ${JSON.stringify(result)}`);
  const scope = result.ok ? result.scope : null;
  const instances = scope
    ? (INSTANCES_USER_SCOPE_ONLY[`${scope.sessionId}::${scope.workspaceName}`] ?? [])
    : [];
  const matchedInstance = findInstance(instances, TARGET);
  lines.push(
    `Simulating identify-installed-artifact.mjs's matchedInstance lookup against that scope's own ` +
      `runtime-ui:getSnapshot instances (${JSON.stringify(instances)}): matchedInstance = ` +
      `${JSON.stringify(matchedInstance)}`,
  );
  const ok =
    result.ok === true &&
    result.matchedVia === "no-instance-match-fallback" &&
    matchedInstance === null;
  lines.push(
    ok
      ? "REPRODUCED: the pre-repair code falls back to the legacy session heuristic (session-1) and " +
          "matchedInstance is null even though the target's pane IS open — under the persistent user " +
          "scope, which this code never enumerated (the exact live defect: " +
          "verification/identify-l2005-live-scopefix-residual.json)."
      : "FAIL: expected the unrepaired code to miss the user-scope-only instance.",
  );
  return { lines, ok };
}

async function captureGreenUserScopeOnly() {
  const lines = [
    "=== L2-005 RESIDUAL GREEN (a): finds a nav-opened instance owned only by the persistent user scope ===",
    "",
  ];
  const result = selectScopeForIdentifyCurrent({
    sessionsListResponse: SESSIONS,
    instancesByScope: INSTANCES_USER_SCOPE_ONLY,
    target: TARGET,
  });
  lines.push(
    "Calling the CURRENT selectScopeForIdentify() with the SAME fixture as the red reproduction above...",
  );
  lines.push(`Result: ${JSON.stringify(result)}`);
  const ok =
    result.ok === true &&
    result.matchedVia === "single-instance-candidate" &&
    result.scope?.applicationScope === "user" &&
    result.scope?.workspaceName === "marshal";
  lines.push(
    ok
      ? 'The persistent user scope {applicationScope:"user", workspaceName:"marshal"} is selected — ' +
          "not the active session-1 — because it is the only candidate whose own runtime-ui:getSnapshot " +
          "instances actually own the target application. publication/declaredActions/viewport can now " +
          "run against the real nav-opened instance."
      : "FAIL: expected the persistent user scope to be selected.",
  );
  return { lines, ok };
}

async function captureGreenSessionStillFound() {
  const lines = [
    "=== L2-005 RESIDUAL GREEN (b): a session-owned instance is still found — no regression ===",
    "",
  ];
  const sessions = {
    success: true,
    sessions: [
      { id: "session-1", workspaceName: "marshal-host", isActive: true },
      { id: "session-2", workspaceName: "codereview-workspace", isActive: false },
    ],
  };
  const instancesByScope = {
    "session-1::marshal-host": [],
    "session-2::codereview-workspace": [MATCHING_INSTANCE],
  };
  const result = selectScopeForIdentifyCurrent({
    sessionsListResponse: sessions,
    instancesByScope,
    target: TARGET,
  });
  lines.push(`Result: ${JSON.stringify(result)}`);
  const ok =
    result.ok === true &&
    result.matchedVia === "single-instance-candidate" &&
    result.scope?.sessionId === "session-2";
  lines.push(
    ok
      ? "session-2 is still selected exactly as the original L2-005 fix intended — enumerating the " +
          "persistent scope alongside sessions did not disturb session-owned instance discovery."
      : "FAIL: expected the session-owned instance to still be found.",
  );
  return { lines, ok };
}

async function captureGreenMixedCandidateRefusal() {
  const lines = [
    "=== L2-005 RESIDUAL GREEN (c): a session AND the persistent user scope both owning the instance is a typed refusal listing both ===",
    "",
  ];
  const instancesByScope = {
    "session-1::marshal-host": [MATCHING_INSTANCE],
    "user::marshal": [MATCHING_INSTANCE],
  };
  const result = selectScopeForIdentifyCurrent({
    sessionsListResponse: SESSIONS,
    instancesByScope,
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
      ? "REFUSED with code multi-candidate-no-override, listing both the session and the persistent " +
          "scope candidate — never guesses which of two equally-plausible open instances the operator " +
          "meant; asks for a scopeOverride (with applicationScope to disambiguate) instead."
      : "FAIL: expected a typed refusal listing exactly the session and persistent-scope candidates.",
  );
  return { lines, ok };
}

async function captureGreenPersistentOverride() {
  const lines = [
    "=== L2-005 RESIDUAL GREEN (d): an operator-pinned override selecting the persistent user scope works ===",
    "",
  ];
  const result = selectScopeForIdentifyCurrent({
    sessionsListResponse: SESSIONS,
    override: { applicationScope: "user", workspaceName: "marshal" },
    instancesByScope: {}, // deliberately empty — an override is trusted directly, never cross-checked
    target: TARGET,
  });
  lines.push(`Result: ${JSON.stringify(result)}`);
  const ok =
    result.ok === true &&
    result.matchedVia === "override" &&
    result.scope?.applicationScope === "user" &&
    result.scope?.workspaceName === "marshal";
  lines.push(
    ok
      ? "The persistent user scope is selected via the pinned override, bypassing automatic candidate " +
          "search entirely."
      : "FAIL: expected the override to resolve to the persistent user scope.",
  );
  return { lines, ok };
}

async function captureGreenUnresolvablePersistentOverride() {
  const lines = [
    "=== L2-005 RESIDUAL GREEN (e): an unresolvable persistent-scope override is a typed refusal, never a silent fallback ===",
    "",
  ];
  const result = selectScopeForIdentifyCurrent({
    sessionsListResponse: SESSIONS,
    override: { applicationScope: "user", workspaceName: "nonexistent-workspace" },
    instancesByScope: INSTANCES_USER_SCOPE_ONLY,
    target: TARGET,
  });
  lines.push(`Result: ${JSON.stringify(result)}`);
  const ok = result.ok === false && result.code === "scope-override-unresolvable";
  lines.push(
    ok
      ? "REFUSED with code scope-override-unresolvable — an operator-pinned persistent scope that " +
          "doesn't resolve is never silently re-derived from auto-discovery."
      : "FAIL: expected an unresolvable persistent-scope override to refuse, not fall back.",
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
  const redPath = writeLines("l2005b-red.txt", [red]);

  const greenA = await captureGreenUserScopeOnly();
  const greenB = await captureGreenSessionStillFound();
  const greenC = await captureGreenMixedCandidateRefusal();
  const greenD = await captureGreenPersistentOverride();
  const greenE = await captureGreenUnresolvablePersistentOverride();
  const greenPath = writeLines("l2005b-green.txt", [greenA, greenB, greenC, greenD, greenE]);

  const summary = {
    redPath,
    greenPath,
    redOk: red.ok,
    greenOk: greenA.ok && greenB.ok && greenC.ok && greenD.ok && greenE.ok,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = summary.redOk && summary.greenOk ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
