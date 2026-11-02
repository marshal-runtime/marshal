import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { computeRuntimeExtensionIntegrity } from "@marshal/agent-runtime-extensions";

import {
  findPublishedApplicationRecord,
  verifyApplicationPublication,
  verifyDeclaredActions,
  verifyInstalledIdentity,
} from "./identity-verification.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A real, checked-in, deterministic directory this facility already ships — used so integrity tests
// independently recompute a real package-tree digest rather than mocking computeRuntimeExtensionIntegrity.
const SAMPLE_APP_ROOT = path.resolve(__dirname, "..", "sample-app");
const REAL_INTEGRITY = computeRuntimeExtensionIntegrity(SAMPLE_APP_ROOT).value;

const TARGET = {
  identity: "publisher/sample-extension",
  applicationId: "sample-app",
  expectedIntegrity: REAL_INTEGRITY,
};
const SCOPE = { sessionId: "session-1", workspaceName: "workspace-1" };

function installedEnabledItem(overrides = {}) {
  return {
    identity: TARGET.identity,
    version: "1.0.0",
    status: "installed-enabled",
    packageRoot: SAMPLE_APP_ROOT,
    ...overrides,
  };
}

// F-005 (d): empty/invalid scope must fail, never silently pass.
void test("verifyInstalledIdentity fails when no real scope was discovered", () => {
  const result = verifyInstalledIdentity({
    scope: null,
    target: TARGET,
    status: { success: true, value: { items: [] } },
    snapshot: { success: true, value: { instances: [] } },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty scope/);
});

void test("verifyInstalledIdentity fails when no target identity was provided", () => {
  const result = verifyInstalledIdentity({
    scope: SCOPE,
    target: undefined,
    status: { success: true, value: { items: [] } },
    snapshot: { success: true, value: { instances: [] } },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /explicit target/);
});

// F-005 (d): success:false on either envelope must fail, never be reported as a pass.
void test("verifyInstalledIdentity fails when runtime-extensions:status envelope reports success:false", () => {
  const result = verifyInstalledIdentity({
    scope: SCOPE,
    target: TARGET,
    status: { success: false, error: "Invalid Runtime extension request." },
    snapshot: { success: true, value: { instances: [] } },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /runtime-extensions:status did not succeed/);
  assert.match(result.reason, /Invalid Runtime extension request/);
});

void test("verifyInstalledIdentity fails when runtime-ui:getSnapshot envelope reports success:false", () => {
  const result = verifyInstalledIdentity({
    scope: SCOPE,
    target: TARGET,
    status: { success: true, value: { items: [installedEnabledItem()] } },
    snapshot: {
      success: false,
      error: { code: "invalid-request", message: "Workspace name is required." },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /runtime-ui:getSnapshot did not succeed/);
  assert.match(result.reason, /Workspace name is required/);
});

void test("verifyInstalledIdentity fails when no installed extension matches the target identity", () => {
  const result = verifyInstalledIdentity({
    scope: SCOPE,
    target: TARGET,
    status: {
      success: true,
      value: {
        items: [installedEnabledItem({ identity: "some/other-extension", version: "2.0.0" })],
      },
    },
    snapshot: { success: true, value: { instances: [] } },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No ENABLED, INSTALLED extension matched identity/);
});

// F-005b Defect 1 — ported/adapted from Codex's independent negative probe
// (verification/d4-independent-negative.mjs, read-only): a merely-"detected" candidate must never satisfy
// the identity gate, even though its identity string matches exactly.
void test("verifyInstalledIdentity fails for a detected-but-not-installed candidate (Codex negative probe)", () => {
  const result = verifyInstalledIdentity({
    scope: { workspaceName: "marshal" },
    target: { identity: "@test/app", applicationId: "app" },
    status: {
      success: true,
      value: { items: [{ identity: "@test/app", version: "1.0.0", status: "detected" }] },
    },
    snapshot: { success: true, value: { instances: [] } },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /status must be exactly "installed-enabled"/);
  assert.match(result.reason, /detected/);
});

void test("verifyInstalledIdentity fails for an installed-but-disabled candidate", () => {
  const result = verifyInstalledIdentity({
    scope: SCOPE,
    target: TARGET,
    status: {
      success: true,
      value: { items: [installedEnabledItem({ status: "installed-disabled" })] },
    },
    snapshot: { success: true, value: { instances: [] } },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /status must be exactly "installed-enabled"/);
  assert.match(result.reason, /installed-disabled/);
});

// F-005b Defect 1 (i): first-match-wins must not let a stale/older detected candidate shadow the actually
// installed-enabled one — the correct candidate is chosen regardless of array order.
void test("verifyInstalledIdentity picks the enabled installed candidate over a stale detected candidate listed first", () => {
  const stale = { identity: TARGET.identity, version: "0.9.0", status: "detected" };
  const result = verifyInstalledIdentity({
    scope: SCOPE,
    target: TARGET,
    status: { success: true, value: { items: [stale, installedEnabledItem()] } },
    snapshot: { success: true, value: { instances: [] } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.matchedIdentity.status, "installed-enabled");
  assert.equal(result.matchedIdentity.version, "1.0.0");
});

void test("verifyInstalledIdentity fails when the matched installed-enabled entry is missing a version", () => {
  const result = verifyInstalledIdentity({
    scope: SCOPE,
    target: TARGET,
    status: { success: true, value: { items: [installedEnabledItem({ version: undefined })] } },
    snapshot: { success: true, value: { instances: [] } },
  });
  assert.equal(result.ok, false);
});

// F-005b Defect 1 (i): integrity gate.
void test("verifyInstalledIdentity fails when no expectedIntegrity was supplied — an installed-enabled status alone is not integrity proof", () => {
  const { expectedIntegrity: _drop, ...targetWithoutIntegrity } = TARGET;
  const result = verifyInstalledIdentity({
    scope: SCOPE,
    target: targetWithoutIntegrity,
    status: { success: true, value: { items: [installedEnabledItem()] } },
    snapshot: { success: true, value: { instances: [] } },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No expected integrity hash was supplied/);
});

void test("verifyInstalledIdentity fails when the matched entry has no packageRoot to recompute integrity from", () => {
  const result = verifyInstalledIdentity({
    scope: SCOPE,
    target: TARGET,
    status: { success: true, value: { items: [installedEnabledItem({ packageRoot: undefined })] } },
    snapshot: { success: true, value: { instances: [] } },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /carries no packageRoot/);
});

void test("verifyInstalledIdentity fails when independently recomputed integrity does not match the expected value", () => {
  const result = verifyInstalledIdentity({
    scope: SCOPE,
    target: { ...TARGET, expectedIntegrity: "0".repeat(64) },
    status: { success: true, value: { items: [installedEnabledItem()] } },
    snapshot: { success: true, value: { instances: [] } },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match the expected pinned value/);
});

void test("verifyInstalledIdentity fails when the packageRoot cannot be read for integrity recomputation", () => {
  const result = verifyInstalledIdentity({
    scope: SCOPE,
    target: TARGET,
    status: {
      success: true,
      value: {
        items: [
          installedEnabledItem({ packageRoot: path.join(SAMPLE_APP_ROOT, "does-not-exist-xyz") }),
        ],
      },
    },
    snapshot: { success: true, value: { instances: [] } },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Failed to independently recompute integrity/);
});

void test("verifyInstalledIdentity passes and notes missing geometry/publication/declaredActions when no instance is open", () => {
  const result = verifyInstalledIdentity({
    scope: SCOPE,
    target: TARGET,
    status: { success: true, value: { items: [installedEnabledItem()] } },
    snapshot: { success: true, value: { instances: [] } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.matchedInstance, undefined);
  assert.equal(result.gates.identity.met, true);
  assert.equal(result.gates.integrity.met, true);
  assert.equal(result.gates.integrity.value, REAL_INTEGRITY);
  assert.match(result.limits[0], /publication, and declared actions were not captured this run/);
});

void test("verifyInstalledIdentity passes with a matched instance for geometry capture", () => {
  const instance = {
    instanceId: "instance-1",
    surface: "panel",
    owner: { extensionId: TARGET.identity, applicationId: TARGET.applicationId },
  };
  const result = verifyInstalledIdentity({
    scope: SCOPE,
    target: TARGET,
    status: { success: true, value: { items: [installedEnabledItem()] } },
    snapshot: { success: true, value: { instances: [instance] } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.matchedInstance, instance);
  assert.deepEqual(result.limits, []);
});

// F-005b (ii): current-publication gate — the matched application's resource must actually resolve via a
// live read, not just be assumed from the snapshot descriptor.
void test("verifyApplicationPublication is not applicable without an applicationId target", () => {
  const result = verifyApplicationPublication({
    target: { identity: "x" },
    matchedInstance: undefined,
    resource: undefined,
  });
  assert.equal(result.applicable, false);
});

void test("verifyApplicationPublication is unmet (not verified) when no instance matched", () => {
  const result = verifyApplicationPublication({
    target: TARGET,
    matchedInstance: undefined,
    resource: undefined,
  });
  assert.equal(result.applicable, true);
  assert.equal(result.met, false);
});

void test("verifyApplicationPublication is unmet when runtime-ui:readResource fails", () => {
  const result = verifyApplicationPublication({
    target: TARGET,
    matchedInstance: { instanceId: "i1" },
    resource: { success: false, error: "boom" },
  });
  assert.equal(result.met, false);
  assert.match(result.reason, /boom/);
});

void test("verifyApplicationPublication is unmet when the resource read succeeds but carries no revisionId", () => {
  const result = verifyApplicationPublication({
    target: TARGET,
    matchedInstance: { instanceId: "i1" },
    resource: { success: true, value: {} },
  });
  assert.equal(result.met, false);
});

void test("verifyApplicationPublication is met when the live resource read returns a revisionId", () => {
  const result = verifyApplicationPublication({
    target: TARGET,
    matchedInstance: { instanceId: "i1" },
    resource: { success: true, value: { revisionId: "rev-1" } },
  });
  assert.equal(result.met, true);
  assert.equal(result.revisionId, "rev-1");
});

// N-FF1 + L2R-001: declared-actions gate — the evidence source is the PUBLICATION application record
// (runtime-ui:getPlacements, live-resolved from the publication service), never the matched instance's
// content.descriptor (an open-time snapshot frozen at controller.open, never refreshed on update). The
// previous gate read `descriptor.declaredActions`, a field no product surface ever emits.
// N-FF1b: the bridge FLATTENS the published manifest onto the placement application entry —
// toDesktopPlacementApplication (electron/ipc/runtime-ui-ipc.ts) emits top-level actions[] (ids),
// tools[] (names) and revisionId; there is no nested `application` manifest over this projection.
// publishedRecord() below models exactly that emitted shape, and the composition test
// electron/ipc/runtime-ui-facility-composition.test.ts proves it against the REAL registered handler.
const STALE_INSTANCE = {
  instanceId: "instance-1",
  owner: { extensionId: TARGET.identity, applicationId: TARGET.applicationId },
  content: {
    kind: "application",
    descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
  },
};

function publishedRecord(overrides = {}) {
  return {
    extensionId: TARGET.identity,
    applicationId: TARGET.applicationId,
    title: "Sample application",
    renderId: "sample-app",
    action: "augment",
    revisionId: "rev-1",
    actions: [{ id: "read" }, { id: "write" }],
    tools: [{ id: "sample-tool", name: "sample.tool" }],
    ...overrides,
  };
}

void test("verifyDeclaredActions is not applicable without an applicationId target", () => {
  const result = verifyDeclaredActions({
    target: { identity: "x" },
    matchedInstance: undefined,
    publication: undefined,
  });
  assert.equal(result.applicable, false);
});

void test("verifyDeclaredActions is unmet (not verified) when no instance anchored the application", () => {
  const result = verifyDeclaredActions({
    target: TARGET,
    matchedInstance: undefined,
    publication: { success: true, record: publishedRecord() },
  });
  assert.equal(result.applicable, true);
  assert.equal(result.met, false);
  assert.match(result.reason, /No open application instance matched/);
});

void test("verifyDeclaredActions is unmet when the publication surface read failed", () => {
  const result = verifyDeclaredActions({
    target: TARGET,
    matchedInstance: STALE_INSTANCE,
    publication: { success: false, error: "boom" },
  });
  assert.equal(result.met, false);
  assert.match(result.reason, /publication surface could not be read/);
  assert.match(result.reason, /boom/);
});

void test("verifyDeclaredActions is unmet when the publication lists no record for the target application", () => {
  const result = verifyDeclaredActions({
    target: TARGET,
    matchedInstance: STALE_INSTANCE,
    publication: { success: true, record: null },
  });
  assert.equal(result.met, false);
  assert.match(result.reason, /listed no application record/);
});

void test("verifyDeclaredActions is unmet when the record carries no top-level actions/tools fields over the bridge", () => {
  // The bridge omits both fields when the published record has no manifest
  // (toDesktopPlacementApplication spreads them conditionally).
  const { actions: _dropActions, tools: _dropTools, ...recordWithoutManifest } = publishedRecord();
  const result = verifyDeclaredActions({
    target: TARGET,
    matchedInstance: STALE_INSTANCE,
    publication: { success: true, record: recordWithoutManifest },
  });
  assert.equal(result.met, false);
  assert.match(result.reason, /no top-level actions\[\]\/tools\[\] fields/);
});

void test("verifyDeclaredActions is unmet when the publication record declares no actions or tools", () => {
  const result = verifyDeclaredActions({
    target: TARGET,
    matchedInstance: STALE_INSTANCE,
    publication: {
      success: true,
      record: publishedRecord({ actions: [], tools: [] }),
    },
  });
  assert.equal(result.met, false);
  assert.match(result.reason, /declares no actions and no tools/);
});

void test("verifyDeclaredActions reads-but-does-not-verify when no expected set is supplied", () => {
  const result = verifyDeclaredActions({
    target: TARGET,
    matchedInstance: STALE_INSTANCE,
    publication: { success: true, record: publishedRecord() },
  });
  assert.equal(result.met, false);
  assert.deepEqual(result.declaredActions, ["read", "write"]);
  assert.deepEqual(result.declaredTools, ["sample.tool"]);
  assert.match(result.reason, /not verified against an expected set/);
});

void test("verifyDeclaredActions matches the publication's action ids regardless of order", () => {
  const result = verifyDeclaredActions({
    target: { ...TARGET, expectedDeclaredActions: ["write", "read"] },
    matchedInstance: STALE_INSTANCE,
    publication: { success: true, record: publishedRecord() },
  });
  assert.equal(result.met, true);
  assert.equal(result.revisionId, "rev-1");
});

void test("verifyDeclaredActions fails honestly when the publication genuinely lacks an expected action", () => {
  const result = verifyDeclaredActions({
    target: { ...TARGET, expectedDeclaredActions: ["read", "write", "missing-action"] },
    matchedInstance: STALE_INSTANCE,
    publication: { success: true, record: publishedRecord() },
  });
  assert.equal(result.met, false);
  assert.match(result.reason, /do not match the expected/);
  assert.match(result.reason, /missing-action/);
});

void test("verifyDeclaredActions checks expectedDeclaredTools against the publication manifest's tools[].name", () => {
  const met = verifyDeclaredActions({
    target: {
      ...TARGET,
      expectedDeclaredActions: ["read", "write"],
      expectedDeclaredTools: ["sample.tool"],
    },
    matchedInstance: STALE_INSTANCE,
    publication: { success: true, record: publishedRecord() },
  });
  assert.equal(met.met, true);
  const unmet = verifyDeclaredActions({
    target: {
      ...TARGET,
      expectedDeclaredActions: ["read", "write"],
      expectedDeclaredTools: ["missing.tool"],
    },
    matchedInstance: STALE_INSTANCE,
    publication: { success: true, record: publishedRecord() },
  });
  assert.equal(unmet.met, false);
  assert.match(unmet.reason, /tool names/);
});

// L2R-001: the instance's open-time descriptor snapshot must never be consulted for actions — a stale
// (empty) instance descriptor with a fresh publication record is MET, and the descriptor is proven
// untouched via an access trap.
void test("verifyDeclaredActions never consults the instance descriptor: stale instance + fresh publication is MET", () => {
  let descriptorAccessed = false;
  const trappedInstance = {
    instanceId: "instance-1",
    owner: { extensionId: TARGET.identity, applicationId: TARGET.applicationId },
    content: new Proxy(
      { kind: "application", descriptor: { actions: [], tools: [] } },
      {
        get(object, property, receiver) {
          if (property === "descriptor") descriptorAccessed = true;
          return Reflect.get(object, property, receiver);
        },
      },
    ),
  };
  const result = verifyDeclaredActions({
    target: { ...TARGET, expectedDeclaredActions: ["read", "write"] },
    matchedInstance: trappedInstance,
    publication: { success: true, record: publishedRecord() },
  });
  assert.equal(result.met, true);
  assert.equal(descriptorAccessed, false);
});

// findPublishedApplicationRecord: pure extraction of the publication application record from a
// runtime-ui:getPlacements snapshot.
void test("findPublishedApplicationRecord finds the target's record across placements", () => {
  const record = publishedRecord();
  const snapshot = {
    placements: [
      {
        metadata: { id: "nav.primary" },
        applications: [{ extensionId: "other", applicationId: "x" }],
      },
      { metadata: { id: "tab.main" }, applications: [record] },
    ],
  };
  assert.equal(findPublishedApplicationRecord({ snapshot, target: TARGET }), record);
});

void test("findPublishedApplicationRecord returns null when the application is not in the snapshot", () => {
  const snapshot = {
    placements: [{ metadata: { id: "nav.primary" }, applications: [] }],
  };
  assert.equal(findPublishedApplicationRecord({ snapshot, target: TARGET }), null);
  assert.equal(findPublishedApplicationRecord({ snapshot: undefined, target: TARGET }), null);
  assert.equal(
    findPublishedApplicationRecord({
      snapshot,
      target: { identity: "publisher/sample-extension" },
    }),
    null,
  );
});
