#!/usr/bin/env node
// L2-005 deliverable: AUTHORIZED, narrow, read-only live verification against
// the REAL, running Marshal — same pattern as F-DEPLOY-2b's
// capture-facfix2-live-receipt.mjs. Demonstrates the repaired scope discovery
// (lib/live-scope-discovery.mjs's selectScopeForIdentify, exercised through
// discoverLiveScope) actually finding the real open codereview.prs instance
// and reading its publication/declaredActions/viewport — the three gates
// that were unreachable while matchedInstance was always null
// (verification/l2/l2-1-identify-code-review-v2-facility.json).
//
// Scope note: this intentionally calls discoverLiveScope() directly and then
// performs the SAME post-verification reads identify-installed-artifact.mjs
// performs (runtime-extensions-ui:getSnapshot, runtime-ui:readResource, the
// frame-geometry probe) — it does not go through
// ACCEPTANCE_FACILITY_LIVE_TARGET's identity+integrity gate
// (lib/identity-verification.mjs). That gate's live behavior is a DIFFERENT,
// already-proven mechanism (Field Guide: "the F-005/F-005b integrity-gate
// design proved itself live"; L2 independently re-ran the full identify path
// twice) and requires an independently-known package digest this task has no
// legitimate way to obtain for @marshal/code-review (unlike a first-party
// bundled extension, its integrity is not checked into this repo — see
// electron/marshal-runtime/first-party-extension-catalog.ts). This script's
// job is narrowly to prove the L2-005 fix itself: that scope discovery,
// against the real host, finds the instance the old active/first-session
// heuristic could not, and that the three gates it unblocks actually read
// real data. Read-only: no mutation, no evaluates beyond what
// identify-installed-artifact.mjs already performs post-verification.
//
// If the codereview.prs pane is not open at run time, this records that
// honestly and exits 0 — a blocked/unmet outcome is a legitimate, explicitly
// authorized result (see this task's objective), not a failure of this
// script; the deterministic red/green fixture coverage in
// lib/live-scope-discovery.test.mjs and test-receipts/l2005-{red,green}.txt
// is this repair's primary proof either way.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFrameGeometryExpression } from "../lib/frame-geometry.mjs";
import {
  findPublishedApplicationRecord,
  verifyDeclaredActions,
} from "../lib/identity-verification.mjs";
import {
  connectToRunningMarshal,
  evaluateInRenderer,
  LiveConnectionRefusalError,
  liveModePort,
  liveModeRequested,
} from "../lib/live-connection.mjs";
import { discoverLiveScope, ScopeDiscoveryRefusalError } from "../lib/live-scope-discovery.mjs";
import { writeReceipt } from "../lib/receipt.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_RECEIPTS_DIR = path.resolve(__dirname, "..", "test-receipts");
const EXAMPLE_RECEIPTS_DIR = path.resolve(
  __dirname,
  "..",
  "example-receipts",
  "live-demonstration",
);
const RECEIPT_JSON_PATH = path.join(EXAMPLE_RECEIPTS_DIR, "l2005-live-9333.json");
const RECEIPT_TXT_PATH = path.join(TEST_RECEIPTS_DIR, "l2005-live-9333.txt");

const TARGET = { identity: "@marshal/code-review", applicationId: "codereview.prs" };
const SUBJECT =
  "L2-005: corrected scope discovery finding the real open codereview.prs instance and reading its " +
  "publication/declaredActions/viewport";

function writeTxt(lines) {
  fs.mkdirSync(TEST_RECEIPTS_DIR, { recursive: true });
  fs.writeFileSync(RECEIPT_TXT_PATH, `${lines.join("\n")}\n`);
}

async function main() {
  const lines = [
    "=== L2-005 LIVE VERIFICATION: corrected scope discovery against the real, running Marshal ===",
    "",
  ];
  if (!liveModeRequested()) {
    throw new Error(
      "ACCEPTANCE_FACILITY_ALLOW_LIVE=1 is required — this script connects to a real, running Marshal.",
    );
  }
  const port = liveModePort();
  lines.push(`Explicit port: ${port} (ACCEPTANCE_FACILITY_CDP_PORT) — no default.`);
  lines.push(`Target: ${JSON.stringify(TARGET)}`);
  lines.push("");

  let client;
  try {
    lines.push(`Calling connectToRunningMarshal(${port})...`);
    ({ client } = await connectToRunningMarshal(port));
    lines.push(
      "ACCEPTED — endpoint verified (User-Agent metadata + the mandatory marker-probe evaluate), " +
        "marshal://app page matched.",
    );
    lines.push("");
    lines.push("Calling discoverLiveScope() — the L2-005 repair under test...");
    // L2-005 residual (branch (ii)): discoverLiveScope now returns TWO scopes; this script only needs
    // instanceScope (getSnapshot/readResource/geometry) — it deliberately does not call
    // runtimeExtensionsAPI.status (see header comment), so sessionScope is unused here.
    const { instanceScope: scope } = await discoverLiveScope(client, evaluateInRenderer, TARGET);
    lines.push(`Result: ${JSON.stringify(scope)}`);
    if (!scope) {
      lines.push("No open session at all right now — nothing further to check this run.");
      writeReceipt(RECEIPT_JSON_PATH, {
        evidenceClass: "installed-api",
        status: "blocked",
        facility: "identify-installed-artifact",
        subject: SUBJECT,
        reason:
          "No open session/workspace was discoverable from window.sessionsAPI.list() at run time.",
      });
      return;
    }
    lines.push("");
    lines.push(
      "Calling runtime-ui:getSnapshot(scope) — the same evaluate identify-installed-artifact.mjs performs...",
    );
    const snapshot = JSON.parse(
      await evaluateInRenderer(
        client,
        `window.runtimeUiAPI.getSnapshot(${JSON.stringify(scope)}).then((r) => JSON.stringify(r))`,
      ),
    );
    if (!snapshot?.success) {
      lines.push(`runtime-ui:getSnapshot did not succeed: ${JSON.stringify(snapshot?.error)}`);
      writeReceipt(RECEIPT_JSON_PATH, {
        evidenceClass: "installed-api",
        status: "blocked",
        facility: "identify-installed-artifact",
        subject: SUBJECT,
        reason: "runtime-ui:getSnapshot did not succeed against the discovered scope.",
        proof: { scope, snapshotSuccess: false, snapshotError: snapshot?.error },
      });
      return;
    }
    const instances = Array.isArray(snapshot.value?.instances) ? snapshot.value.instances : [];
    const matchedInstance = instances.find(
      (instance) =>
        instance?.owner?.extensionId === TARGET.identity &&
        instance?.owner?.applicationId === TARGET.applicationId,
    );
    lines.push(
      `instances in this scope: ${instances.length}; matchedInstance: ` +
        `${JSON.stringify(matchedInstance ?? null)}`,
    );
    if (!matchedInstance) {
      lines.push(
        "The codereview.prs pane is NOT open under the discovered scope right now — recording this " +
          "honestly as a blocked/unmet outcome, per this task's authorization: the deterministic red/green " +
          "fixture coverage stands regardless.",
      );
      writeReceipt(RECEIPT_JSON_PATH, {
        evidenceClass: "installed-api",
        status: "blocked",
        facility: "identify-installed-artifact",
        subject: SUBJECT,
        reason: "No open codereview.prs instance was found under the discovered scope at run time.",
        proof: { scope, instanceCount: instances.length },
      });
      return;
    }
    lines.push("MATCHED — the L2-005 fix found the real open instance.");
    lines.push("");

    let publicationGate;
    const resourceUri = matchedInstance.content?.resource?.uri;
    if (resourceUri) {
      lines.push(
        "Calling runtime-ui:readResource(...) — the same evaluate identify-installed-artifact.mjs performs " +
          "for the publication gate...",
      );
      // L2-005 residual: spread `scope` (may be persistent, {applicationScope, workspaceName}) rather than
      // naming sessionId/workspaceName explicitly.
      const resource = JSON.parse(
        await evaluateInRenderer(
          client,
          `window.runtimeUiAPI.readResource(${JSON.stringify({
            ...scope,
            extensionId: TARGET.identity,
            applicationId: TARGET.applicationId,
            instanceId: matchedInstance.instanceId,
            uri: resourceUri,
          })}).then((r) => JSON.stringify(r))`,
        ),
      );
      publicationGate = {
        applicable: true,
        met: Boolean(resource?.success && resource.value?.revisionId),
        revisionId: resource?.value?.revisionId,
      };
    } else {
      publicationGate = { applicable: false };
    }
    lines.push(`publication gate: ${JSON.stringify(publicationGate)}`);

    // N-FF1 + L2R-001: the declared-actions evidence source is the PUBLICATION application record
    // (runtime-ui:getPlacements), never matchedInstance.content.descriptor (an open-time snapshot).
    // The checked-in test-receipts/l2005-live-9333.txt predates this repair and is kept verbatim as a
    // historical record of the pre-repair gate. Post-guard evaluate, same class as the reads above.
    lines.push(
      "Calling runtime-ui:getPlacements(scope) — the publication surface the repaired declared-actions " +
        "gate reads (N-FF1 + L2R-001)...",
    );
    let placementsEnvelope;
    try {
      placementsEnvelope = JSON.parse(
        await evaluateInRenderer(
          client,
          `window.runtimeUiAPI.getPlacements(${JSON.stringify(scope)}).then(` +
            "(snapshot) => JSON.stringify({ success: true, value: snapshot }), " +
            "(error) => JSON.stringify({ success: false, error: error && error.message ? error.message : String(error) }))",
        ),
      );
    } catch (error) {
      placementsEnvelope = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const declaredActionsGate = verifyDeclaredActions({
      target: TARGET,
      matchedInstance,
      publication: placementsEnvelope?.success
        ? {
            success: true,
            record: findPublishedApplicationRecord({
              snapshot: placementsEnvelope.value,
              target: TARGET,
            }),
          }
        : placementsEnvelope,
    });
    lines.push(`declaredActions gate: ${JSON.stringify(declaredActionsGate)}`);

    let geometry = null;
    try {
      const expectedTitle =
        matchedInstance.content?.kind === "application"
          ? (matchedInstance.content.resource?.name ?? matchedInstance.owner?.applicationId)
          : undefined;
      const expression = buildFrameGeometryExpression({
        surface: matchedInstance.surface,
        expectedTitle,
      });
      geometry = JSON.parse(await evaluateInRenderer(client, expression));
    } catch (error) {
      geometry = { error: error instanceof Error ? error.message : String(error) };
    }
    lines.push(`viewport geometry: ${JSON.stringify(geometry)}`);

    writeReceipt(RECEIPT_JSON_PATH, {
      evidenceClass: "installed-api",
      status: "pass",
      facility: "identify-installed-artifact",
      subject: SUBJECT,
      proof: {
        scope,
        target: TARGET,
        matchedInstance: {
          instanceId: matchedInstance.instanceId,
          owner: matchedInstance.owner,
          surface: matchedInstance.surface,
        },
        gates: { publication: publicationGate, declaredActions: declaredActionsGate },
        geometry,
      },
      limits: [
        "This narrow live verification exercises scope discovery + publication/declaredActions/viewport " +
          "directly; it deliberately does not go through ACCEPTANCE_FACILITY_LIVE_TARGET's identity+" +
          "integrity gate (a separately-proven mechanism — see this script's header comment), so no " +
          "identity/integrity gate result is reported here.",
        "proof is a summary, not the raw envelopes — see identify-installed-artifact.mjs's own receipt for " +
          "the redaction rationale.",
      ],
    });
  } catch (error) {
    const isRefusal =
      error instanceof LiveConnectionRefusalError || error instanceof ScopeDiscoveryRefusalError;
    lines.push(
      `${isRefusal ? "REFUSED" : "ERROR"}: ${error.code ?? error.constructor.name}: ${error.message}`,
    );
    writeReceipt(RECEIPT_JSON_PATH, {
      evidenceClass: "installed-api",
      status: isRefusal ? "blocked" : "fail",
      facility: "identify-installed-artifact",
      subject: SUBJECT,
      reason: error instanceof Error ? error.message : String(error),
      ...(isRefusal ? { proof: { refusalCode: error.code, candidates: error.candidates } } : {}),
    });
    if (!isRefusal) throw error;
  } finally {
    await client?.close();
    lines.push("");
    lines.push("Clean disconnect. No mutation was performed at any point in this run.");
    writeTxt(lines);
  }
}

main()
  .then(() => {
    process.stdout.write(`${fs.readFileSync(RECEIPT_JSON_PATH, "utf8")}`);
  })
  .catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
