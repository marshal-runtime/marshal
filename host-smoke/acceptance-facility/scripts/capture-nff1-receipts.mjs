#!/usr/bin/env node
// N-FF1 + L2R-001 HONEST-RED/GREEN capture.
//
// N-FF1: the identify step's declared-actions gate read `descriptor.declaredActions` on the matched
// runtime-ui INSTANCE — a field NO product surface ever emits (the real UiApplicationManifest fields
// are `actions[]` with ids and `tools[]` with names, node_modules/@marshal/agent-runtime-ui/dist/
// applicationTypes.d.ts) — so the gate was structurally unmeetable and always reported
// applicable-but-unmet, even against the real live manifest (test-receipts/l2005-live-9333.txt line 18
// captured exactly that against the real open codereview.prs pane).
//
// L2R-001 (adjudicated): even with the right field name, the INSTANCE surface is wrong —
// `content.descriptor` is an OPEN-TIME SNAPSHOT of the publication manifest frozen at controller.open
// (electron/marshal-runtime/ui-controller.ts:846-900), persisted for user-scope instances, never
// refreshed on extension update: arbitrarily stale. The authoritative update-current surface is the
// PUBLICATION application record (runtime-ui:getPlacements — resolved live from the publication
// service's listApplications).
//
// Produces:
//   test-receipts/nff1-red.txt   — the UNMODIFIED b8aac70bb verifyDeclaredActions (extracted via
//     `git show` and dynamically imported — the exact pre-repair code, not a reconstruction) against a
//     live-shaped fixture where the PUBLICATION application record carries the real 21-action
//     code-review shape while the instance descriptor is stale/empty: applicable-but-unmet. A second
//     red section proves structural unmeetability: even an instance descriptor carrying the REAL
//     manifest shape (actions[]/tools[] populated exactly as the live capture showed) is still unmet,
//     because the field `declaredActions` never exists.
//   test-receipts/nff1-green.txt — the CURRENT (repaired) gate: (g1) the same fixture is MET reading
//     the publication surface; (g2) a publication genuinely missing an expected action is honestly
//     unmet with reasons; (g3) stale instance + fresh publication is MET with an access trap proving
//     the instance descriptor is never consulted for actions (the L2R-001 shape).
//
// The 21 action ids and the babysit tool are modeled on the REAL @marshal/code-review manifest as
// captured live in test-receipts/l2005-live-9333.txt (actions incl. the codereview-ai-* ids and
// codereview-thread-applySuggestion; tools incl. codereview.babysit.tick).
//
// Re-runnable on demand; not part of run-all.mjs's offline pipeline (no live Marshal is involved — it
// is a fixture-shaped, deterministic reproduction). Permanent fast regression coverage of the same
// gate logic lives in lib/identity-verification.test.mjs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findPublishedApplicationRecord,
  verifyDeclaredActions as verifyDeclaredActionsCurrent,
} from "../lib/identity-verification.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RECEIPTS_DIR = path.resolve(__dirname, "..", "test-receipts");
const PRE_REPAIR_REF = "b8aac70bb";
const FACILITY_MODULE_PATH = "host-smoke/acceptance-facility/lib/identity-verification.mjs";

const TARGET_BASE = { identity: "@marshal/code-review", applicationId: "codereview.prs" };

// The real code-review action ids, verbatim from the live-captured manifest
// (test-receipts/l2005-live-9333.txt).
const REAL_ACTION_IDS = Object.freeze([
  "codereview-pr-list",
  "codereview-pr-get",
  "codereview-pr-setAutoMerge",
  "codereview-thread-setDisposition",
  "codereview-thread-applySuggestion",
  "codereview-babysit-arm",
  "codereview-babysit-disarm",
  "codereview-pr-requestIteration",
  "codereview-thread-create",
  "codereview-thread-reply",
  "codereview-thread-discardOperation",
  "codereview-accounts-list",
  "codereview-accounts-connect",
  "codereview-sync-discover",
  "codereview-accounts-sources",
  "codereview-accounts-connectFromSource",
  "codereview-accounts-deviceFlow",
  "codereview-ai-ask",
  "codereview-ai-followup",
  "codereview-ai-assignReviewer",
  "codereview-ai-reviewArea",
]);
const REAL_TOOLS = Object.freeze([
  { id: "codereview-babysit-tick", name: "codereview.babysit.tick" },
]);

function freshManifest() {
  return {
    version: "1.0.0",
    presentationModes: ["inline", "fullscreen"],
    actions: REAL_ACTION_IDS.map((id) => ({ id })),
    tools: [...REAL_TOOLS],
  };
}

/**
 * The PUBLICATION application record (the authoritative update-current surface), 21-action shape —
 * modeled on what the getPlacements bridge ACTUALLY emits (N-FF1b): toDesktopPlacementApplication
 * (electron/ipc/runtime-ui-ipc.ts) flattens the published manifest onto the entry as top-level
 * actions[]/tools[] next to revisionId; there is no nested `application` manifest over this bridge.
 */
function publishedApplicationRecord(overrides = {}) {
  return {
    extensionId: TARGET_BASE.identity,
    applicationId: TARGET_BASE.applicationId,
    title: "Pull Requests",
    renderId: "codereview.prs",
    action: "augment",
    revisionId: "d6bdda19e827f1cbfb8955384e2d6b24e2e25010b2ea709b14d5599db4859f53",
    actions: REAL_ACTION_IDS.map((id) => ({ id })),
    tools: [...REAL_TOOLS],
    ...overrides,
  };
}

/** A runtime-ui:getPlacements-shaped snapshot carrying the publication record. */
function placementsSnapshot(record) {
  return {
    revision: 0,
    generatedAt: "2026-09-10T00:00:00.000Z",
    placements: [{ metadata: { id: "nav.primary" }, applications: [record] }],
    diagnostics: [],
  };
}

/** A stale open instance: descriptor frozen at controller.open, before the extension declared actions. */
function staleInstance() {
  return {
    instanceId: "rui_stale",
    surface: "tab",
    owner: { extensionId: TARGET_BASE.identity, applicationId: TARGET_BASE.applicationId },
    content: {
      kind: "application",
      renderId: "codereview.prs",
      resource: { uri: "ui://code-review/codereview.prs.html", mimeType: "text/html" },
      descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
    },
  };
}

const TARGET_WITH_EXPECTATIONS = {
  ...TARGET_BASE,
  expectedDeclaredActions: [...REAL_ACTION_IDS],
  expectedDeclaredTools: REAL_TOOLS.map((tool) => tool.name),
};

/**
 * Extracts the EXACT pre-repair lib/identity-verification.mjs at b8aac70bb via `git show` (a local git
 * object read, no network) and dynamically imports it — the same technique the L2-005-residual capture
 * used — so the red reproduction runs the real historical code, not a reconstruction. The temp module
 * is written INSIDE this facility (not os.tmpdir()) so its bare `@marshal/agent-runtime-extensions`
 * import still resolves against the repo's node_modules; it is removed afterwards.
 */
async function loadPreRepairModule() {
  const source = execFileSync("git", ["show", `${PRE_REPAIR_REF}:${FACILITY_MODULE_PATH}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const tmpDir = fs.mkdtempSync(path.resolve(__dirname, "..", "lib", "nff1-pre-repair-"));
  const tmpFile = path.join(tmpDir, "identity-verification.pre-repair.mjs");
  fs.writeFileSync(tmpFile, source);
  try {
    return {
      module: await import(`file://${tmpFile}`),
      cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

function captureRed(preRepair) {
  const record = publishedApplicationRecord();
  const lines = [
    `=== N-FF1 + L2R-001 RED: unmodified ${PRE_REPAIR_REF} verifyDeclaredActions (extracted via git ` +
      "show, not a reconstruction) ===",
    "",
    "Fixture: the PUBLICATION application record carries the real 21-action code-review shape " +
      "(actions incl. the codereview-ai-* ids and codereview-thread-applySuggestion; tools incl. " +
      "codereview.babysit.tick — modeled verbatim on test-receipts/l2005-live-9333.txt), while the " +
      "open instance's descriptor is a stale open-time snapshot (empty actions[]).",
    `Publication record action ids (${record.actions.length}): ` +
      JSON.stringify(record.actions.map((action) => action.id)),
    `Publication record tool names: ${JSON.stringify(record.tools.map((tool) => tool.name))}`,
    `Expected action ids pinned by the operator: ${JSON.stringify(TARGET_WITH_EXPECTATIONS.expectedDeclaredActions)}`,
    "",
    "(r1) Calling the pre-repair gate — it only ever looks at matchedInstance.content.descriptor." +
      "declaredActions and has no publication input at all...",
  ];
  const r1 = preRepair.verifyDeclaredActions({
    target: TARGET_WITH_EXPECTATIONS,
    matchedInstance: staleInstance(),
  });
  lines.push(`Result: ${JSON.stringify(r1)}`);
  const r1Ok = r1.applicable === true && r1.met === false;
  lines.push(
    r1Ok
      ? "REPRODUCED: applicable-but-unmet even though the CURRENT publication genuinely declares every " +
          "expected action — the gate reads the stale instance snapshot, which is the wrong surface " +
          "(L2R-001)."
      : "FAIL: expected the pre-repair gate to report applicable-but-unmet.",
  );
  lines.push("");
  lines.push(
    "(r2) Structural unmeetability (N-FF1): now give the pre-repair gate an instance descriptor " +
      "carrying the REAL manifest shape — actions[]/tools[] fully populated, exactly what the product " +
      "emits (and what the live capture showed on the real open pane)...",
  );
  const freshInstance = staleInstance();
  freshInstance.content.descriptor = freshManifest();
  const r2 = preRepair.verifyDeclaredActions({
    target: TARGET_WITH_EXPECTATIONS,
    matchedInstance: freshInstance,
  });
  lines.push(`Result: ${JSON.stringify(r2)}`);
  const r2Ok = r2.applicable === true && r2.met === false;
  lines.push(
    r2Ok
      ? "REPRODUCED: STILL applicable-but-unmet with a fully-populated real manifest on the instance — " +
          "the gate reads `descriptor.declaredActions`, a field no product surface ever emits (the real " +
          "fields are actions[]/tools[]), so it could never be met by any deployed extension. This is " +
          'exactly the live outcome in test-receipts/l2005-live-9333.txt line 18 ("No declared actions ' +
          "on the matched instance's descriptor\") captured against the real open codereview.prs pane " +
          "whose descriptor visibly carried all 21 actions."
      : "FAIL: expected the pre-repair gate to be structurally unmeetable.",
  );
  return { lines, ok: r1Ok && r2Ok };
}

function captureGreenMetViaPublication() {
  const lines = [
    "=== N-FF1 GREEN (g1): the repaired gate is MET reading the PUBLICATION surface — same fixture as " +
      "the red reproduction ===",
    "",
  ];
  const record = publishedApplicationRecord();
  const extracted = findPublishedApplicationRecord({
    snapshot: placementsSnapshot(record),
    target: TARGET_BASE,
  });
  lines.push(
    "findPublishedApplicationRecord() extracted the target's record from a runtime-ui:getPlacements-" +
      `shaped snapshot: ${extracted === record ? "yes" : "NO"}`,
  );
  const result = verifyDeclaredActionsCurrent({
    target: TARGET_WITH_EXPECTATIONS,
    matchedInstance: staleInstance(),
    publication: { success: true, record: extracted },
  });
  lines.push(`Result: ${JSON.stringify(result)}`);
  const ok =
    extracted === record &&
    result.met === true &&
    result.declaredActions.length === 21 &&
    result.revisionId === record.revisionId;
  lines.push(
    ok
      ? "MET: all 21 expected action ids (and the babysit tool name) were verified against the " +
          "publication application record's manifest — actions[].id / tools[].name, the fields the " +
          "product actually emits — tied to the publication revisionId."
      : "FAIL: expected the repaired gate to be met via the publication record.",
  );
  return { lines, ok };
}

function captureGreenHonestUnmet() {
  const lines = [
    "=== N-FF1 GREEN (g2): a publication genuinely missing an expected action stays honestly " +
      "applicable-but-unmet, with reasons ===",
    "",
  ];
  const record = publishedApplicationRecord({
    actions: REAL_ACTION_IDS.filter((id) => id !== "codereview-thread-applySuggestion").map(
      (id) => ({ id }),
    ),
  });
  const result = verifyDeclaredActionsCurrent({
    target: TARGET_WITH_EXPECTATIONS,
    matchedInstance: staleInstance(),
    publication: { success: true, record },
  });
  lines.push(
    "Fixture: the publication record drops codereview-thread-applySuggestion (20 of the 21 expected " +
      "actions remain).",
  );
  lines.push(`Result: ${JSON.stringify(result)}`);
  const ok =
    result.applicable === true &&
    result.met === false &&
    typeof result.reason === "string" &&
    result.reason.includes("codereview-thread-applySuggestion");
  lines.push(
    ok
      ? "HONESTLY UNMET: the reason names the publication-declared set vs the expected set — the " +
          "repaired gate never became a rubber stamp."
      : "FAIL: expected an honest unmet naming the missing action.",
  );
  return { lines, ok };
}

function captureGreenInstanceNotConsulted() {
  const lines = [
    "=== L2R-001 GREEN (g3): stale instance + fresh publication is MET, and the instance descriptor " +
      "is provably NOT consulted for actions ===",
    "",
  ];
  let descriptorAccessed = false;
  const trapped = staleInstance();
  trapped.content = new Proxy(trapped.content, {
    get(object, property, receiver) {
      if (property === "descriptor") descriptorAccessed = true;
      return Reflect.get(object, property, receiver);
    },
  });
  const result = verifyDeclaredActionsCurrent({
    target: TARGET_WITH_EXPECTATIONS,
    matchedInstance: trapped,
    publication: { success: true, record: publishedApplicationRecord() },
  });
  lines.push(
    "Fixture: the matched instance's content is wrapped in an access trap recording any read of its " +
      "descriptor; its descriptor is the stale open-time snapshot (empty actions[]).",
  );
  lines.push(`Result: ${JSON.stringify(result)}`);
  lines.push(`content.descriptor accessed during the gate: ${descriptorAccessed}`);
  const ok = result.met === true && descriptorAccessed === false;
  lines.push(
    ok
      ? "MET with the descriptor untouched: the instance match anchors WHICH application/owner is " +
          "checked; the actions evidence comes exclusively from the publication record — the " +
          "authoritative update-current surface (L2R-001's adjudicated mechanism)."
      : "FAIL: expected MET without any descriptor read.",
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
  const { module: preRepair, cleanup } = await loadPreRepairModule();
  let red;
  try {
    red = captureRed(preRepair);
  } finally {
    cleanup();
  }
  const redPath = writeLines("nff1-red.txt", [red]);

  const g1 = captureGreenMetViaPublication();
  const g2 = captureGreenHonestUnmet();
  const g3 = captureGreenInstanceNotConsulted();
  const greenPath = writeLines("nff1-green.txt", [g1, g2, g3]);

  const summary = {
    redPath,
    greenPath,
    redOk: red.ok,
    greenOk: g1.ok && g2.ok && g3.ok,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = summary.redOk && summary.greenOk ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
