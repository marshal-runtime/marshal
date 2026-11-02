#!/usr/bin/env node
// D4, point (a): installed-artifact identification
// (AUDIT-VERDICT-AND-ACCEPTANCE.md "Testing capability gaps", point 1).
// Reports enabled package identity/integrity, application/instance, current
// publication, declared actions, runtime errors, and actual viewport, each
// receipt tied to the installed revision.
//
// F-005 repair (a): the installed-api receipt previously called
// window.runtimeExtensionsAPI.status({}) / window.runtimeUiAPI.getSnapshot({})
// with an EMPTY scope and unconditionally wrote status:"pass" without
// checking the envelope — against a running Marshal both calls actually
// return success:false ("Invalid Runtime extension request.", "Workspace
// name is required."). This now discovers a REAL scope, requires an explicit
// target extension/application, checks every envelope's success flag, and
// can only report "pass" once the target's identity/version were actually
// found in the response. See lib/live-scope-discovery.mjs and
// lib/identity-verification.mjs for the extracted, unit-tested logic.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFrameGeometryExpression } from "../lib/frame-geometry.mjs";
import {
  findPublishedApplicationRecord,
  verifyApplicationPublication,
  verifyDeclaredActions,
  verifyInstalledIdentity,
} from "../lib/identity-verification.mjs";
import { sampleAppIntegrity, withSampleAppKernel } from "../lib/kernel-mock-harness.mjs";
import {
  connectToRunningMarshal,
  evaluateInRenderer,
  LiveConnectionRefusalError,
  liveModePort,
  liveModeRequested,
} from "../lib/live-connection.mjs";
import { discoverLiveScope, ScopeDiscoveryRefusalError } from "../lib/live-scope-discovery.mjs";
import { writeReceipt } from "../lib/receipt.mjs";
import { createSampleAppCapabilityProvider } from "../sample-app/capability-provider.mjs";
import { sampleAppManifest } from "../sample-app/manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.resolve(__dirname, "..", "example-receipts");

async function kernelMockIdentity() {
  const manifest = sampleAppManifest();
  const provider = createSampleAppCapabilityProvider();
  const descriptors = await withSampleAppKernel(
    provider,
    [manifest.declaredPermission],
    (kernel, ctx) => kernel.list(ctx()),
  );
  return writeReceipt(path.join(RECEIPTS_DIR, "identify-installed-artifact.kernel-mock.json"), {
    evidenceClass: "kernel-mock",
    status: "pass",
    facility: "identify-installed-artifact",
    subject: `${manifest.identity}@${manifest.version} registered in a portable RuntimeKernel`,
    revision: {
      identity: manifest.identity,
      version: manifest.version,
      integrity: sampleAppIntegrity(),
    },
    proof: {
      // N-FF1: real manifest field names — actions[] with ids (+ tools[] with names), never the
      // invented `declaredActions`.
      actions: manifest.actions,
      tools: manifest.tools,
      declaredCapabilities: descriptors.map((descriptor) => ({
        name: descriptor.name,
        version: descriptor.version,
        permissions: descriptor.permissions,
      })),
      runtimeErrors: [],
    },
    limits: [
      "Proves the RuntimeKernel contribution/list contract only — not the real installed-extension " +
        "catalog, not the real per-session PermissionPolicy, and has no native viewport (there is no " +
        "rendered frame at this layer). See the installed-api receipt for what only the live app can prove.",
    ],
  });
}

/**
 * F-005b: `expectedIntegrity` (a sha256 hex value the operator independently knows to be the installed
 * revision's real package digest) is now required for the integrity gate to ever be "met" —
 * lib/identity-verification.mjs never treats "installed-enabled" status alone as integrity proof.
 * `expectedDeclaredActions` is optional; when omitted, declared actions are read but reported "unmet" per
 * (iii) rather than silently claimed verified. N-FF1 + L2R-001: expected action ids are checked against
 * the PUBLICATION application record's manifest actions[].id (via runtime-ui:getPlacements), and the
 * optional `expectedDeclaredTools` against its tools[].name — never against the matched instance's
 * open-time descriptor snapshot.
 * L2-005: `scopeOverride` (optional `{sessionId?, workspaceName?, applicationScope?}`) lets an operator who
 * already knows which open session/workspace — or persistent scope, L2-005 residual branch (ii) — owns
 * the target pin it directly, bypassing automatic candidate search — see lib/live-scope-discovery.mjs.
 * @returns {{identity: string, applicationId?: string, expectedIntegrity?: string, expectedDeclaredActions?: string[], expectedDeclaredTools?: string[], scopeOverride?: {sessionId?: string, workspaceName?: string, applicationScope?: string}} | null}
 */
function parseLiveTarget() {
  const raw = process.env.ACCEPTANCE_FACILITY_LIVE_TARGET?.trim();
  if (!raw) return null;
  try {
    // SF-4: operator-authored local target descriptor, not externally supplied data.
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.identity !== "string" || !parsed.identity.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function installedApiIdentity() {
  const receiptPath = path.join(RECEIPTS_DIR, "identify-installed-artifact.installed-api.json");
  const subject =
    "Enabled extension identity/integrity/publication/declared actions/viewport from a running Marshal";
  if (!liveModeRequested()) {
    return writeReceipt(receiptPath, {
      evidenceClass: "installed-api",
      status: "blocked",
      facility: "identify-installed-artifact",
      subject,
      reason:
        "Requires parent deployment step / live authorization: set ACCEPTANCE_FACILITY_ALLOW_LIVE=1 and run " +
        "against an already-running Marshal with a CDP debug port open (e.g. `pnpm electron:debug`). This " +
        "facility never launches, restarts, or builds the live app itself.",
      limits: [
        "Connects via window.sessionsAPI.list()/window.runtimeExtensionsAPI.status()/" +
          "window.runtimeUiAPI.getSnapshot() over CDP (chrome-remote-interface), the same mechanism " +
          "e2e-real/marshal-cdp-helpers.mjs uses.",
        'Usage once live: also set ACCEPTANCE_FACILITY_LIVE_TARGET=\'{"identity":"<installed extension ' +
          'identity>","applicationId":"<its application id>","expectedIntegrity":"<its independently-known ' +
          'sha256 package digest>","expectedDeclaredActions":["<optional expected action ids>"],' +
          '"expectedDeclaredTools":["<optional expected tool names>"],' +
          '"scopeOverride":{"sessionId":"<optional>","workspaceName":"<optional>",' +
          '"applicationScope":"<optional, e.g. user>"}}\' — this facility never ' +
          "guesses which installed extension to identify, nor treats an installed-enabled status alone as " +
          "integrity proof (expectedIntegrity is required for a pass; expectedDeclaredActions is optional " +
          "— omitting it reports that gate unmet, not verified). N-FF1 + L2R-001: the declared-actions " +
          "gate reads the PUBLICATION application record via a post-guard window.runtimeUiAPI." +
          "getPlacements(scope) evaluate and checks expected ids against the publication manifest's " +
          "actions[].id (and expectedDeclaredTools against tools[].name) — never the matched instance's " +
          "content.descriptor, which is an open-time snapshot frozen at controller.open and never " +
          "refreshed on extension update. scopeOverride (L2-005, extended by the " +
          "L2-005 residual repair) lets an operator who already knows which open session/workspace — or " +
          "persistent scope (a nav-opened pane instance, never owned by any session) — owns the target pin " +
          "it directly; a supplied override that doesn't resolve to exactly one open session/persistent " +
          "scope is a typed refusal (blocked), never a silent fallback. Without it, this facility " +
          "auto-discovers the scope by checking every open session's own snapshot plus the persistent user " +
          "scope for the target instance; more than one candidate owning it is also a typed refusal listing " +
          "them, never a guess.",
      ],
    });
  }
  const target = parseLiveTarget();
  if (!target) {
    return writeReceipt(receiptPath, {
      evidenceClass: "installed-api",
      status: "blocked",
      facility: "identify-installed-artifact",
      subject,
      reason:
        "ACCEPTANCE_FACILITY_ALLOW_LIVE=1 was set but ACCEPTANCE_FACILITY_LIVE_TARGET was not provided (or " +
        "was not valid JSON with a non-empty `identity`) — no explicit installed extension/application to " +
        "identify.",
    });
  }
  let client;
  try {
    const port = liveModePort();
    ({ client } = await connectToRunningMarshal(port));
    // L2-005 residual (branch (ii)): discoverLiveScope now returns TWO scopes — runtimeExtensionsAPI.status
    // (the identity/integrity gate) requires a real session scope and can never accept the persistent
    // scope a nav-opened instance may own, while getSnapshot/readResource/geometry should use whichever
    // scope actually owns the target instance (session-shaped or persistent) — see
    // lib/live-scope-discovery.mjs's discoverLiveScope doc comment.
    const { instanceScope, sessionScope } = await discoverLiveScope(
      client,
      evaluateInRenderer,
      target,
    );
    const status = sessionScope
      ? JSON.parse(
          await evaluateInRenderer(
            client,
            `window.runtimeExtensionsAPI.status(${JSON.stringify(sessionScope)}).then((r) => JSON.stringify(r))`,
          ),
        )
      : undefined;
    const snapshot = instanceScope
      ? JSON.parse(
          await evaluateInRenderer(
            client,
            `window.runtimeUiAPI.getSnapshot(${JSON.stringify(instanceScope)}).then((r) => JSON.stringify(r))`,
          ),
        )
      : undefined;
    const verdict = verifyInstalledIdentity({ scope: sessionScope, target, status, snapshot });
    if (!verdict.ok) {
      return writeReceipt(receiptPath, {
        evidenceClass: "installed-api",
        status: "fail",
        facility: "identify-installed-artifact",
        subject,
        reason: verdict.reason,
        // Envelope success flags/errors only — never the raw status()/getSnapshot() values, which can
        // carry live application event/state history even on the failing call.
        proof: {
          instanceScope,
          sessionScope,
          target,
          statusSuccess: status?.success ?? null,
          statusError: status?.success === false ? status.error : undefined,
          snapshotSuccess: snapshot?.success ?? null,
          snapshotError: snapshot?.success === false ? snapshot.error : undefined,
        },
      });
    }
    let geometry;
    const geometryLimits = [];
    if (verdict.matchedInstance) {
      try {
        const expectedTitle =
          verdict.matchedInstance.content?.kind === "application"
            ? (verdict.matchedInstance.content.resource?.name ??
              verdict.matchedInstance.owner?.applicationId)
            : undefined;
        const expression = buildFrameGeometryExpression({
          surface: verdict.matchedInstance.surface,
          expectedTitle,
        });
        geometry = JSON.parse(await evaluateInRenderer(client, expression));
        if (geometry === null) {
          geometryLimits.push(
            "The matched instance exists per runtime-ui:getSnapshot, but its surface was not the " +
              "currently-focused/mounted DOM iframe at capture time (only the most-recently-focused " +
              "instance per surface is mounted) — geometry was not captured this run.",
          );
        }
      } catch (error) {
        geometry = { error: error instanceof Error ? error.message : String(error) };
        geometryLimits.push(
          "Geometry capture threw and was not measured — see proof.geometry.error.",
        );
      }
    }
    // F-005b (ii): when an application target is provided, verify its CURRENT publication (a live
    // runtime-ui:readResource of the matched instance's own resource, not just the snapshot descriptor) —
    // or mark the gate explicitly unmet, never silently claim it was checked.
    let resource;
    if (verdict.matchedInstance) {
      const resourceUri = verdict.matchedInstance.content?.resource?.uri;
      if (resourceUri) {
        try {
          // L2-005 residual: instanceScope may be persistent ({applicationScope, workspaceName}, no
          // sessionId) — spread it rather than naming sessionId/workspaceName explicitly so this request
          // carries whichever scope shape actually owns the instance (electron/ipc/runtime-ui-ipc.ts's
          // requireApplicationInstance accepts either via runtimeUiScopeOf).
          const readRequest = {
            ...instanceScope,
            extensionId: target.identity,
            applicationId: target.applicationId,
            instanceId: verdict.matchedInstance.instanceId,
            uri: resourceUri,
          };
          resource = JSON.parse(
            await evaluateInRenderer(
              client,
              `window.runtimeUiAPI.readResource(${JSON.stringify(readRequest)}).then((r) => JSON.stringify(r))`,
            ),
          );
        } catch (error) {
          resource = {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }
    const publicationGate = verifyApplicationPublication({
      target,
      matchedInstance: verdict.matchedInstance,
      resource,
    });
    // N-FF1 + L2R-001: the declared-actions evidence source is the PUBLICATION application record
    // (runtime-ui:getPlacements, resolved live from the publication service), never the matched
    // instance's content.descriptor (an open-time snapshot frozen at controller.open and never
    // refreshed on extension update). This evaluate runs strictly after the same guard chain
    // (connectToRunningMarshal + discoverLiveScope) as every other evaluate in this script; the
    // matched instance only anchors WHICH extension/application/owner is checked.
    let placementsEnvelope;
    if (target.applicationId && verdict.matchedInstance) {
      try {
        placementsEnvelope = JSON.parse(
          await evaluateInRenderer(
            client,
            `window.runtimeUiAPI.getPlacements(${JSON.stringify(instanceScope)}).then(` +
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
    }
    const declaredActionsGate = verifyDeclaredActions({
      target,
      matchedInstance: verdict.matchedInstance,
      publication: placementsEnvelope?.success
        ? {
            success: true,
            record: findPublishedApplicationRecord({ snapshot: placementsEnvelope.value, target }),
          }
        : placementsEnvelope,
    });
    const gates = {
      ...verdict.gates,
      ...(publicationGate.applicable ? { publication: publicationGate } : {}),
      ...(declaredActionsGate.applicable ? { declaredActions: declaredActionsGate } : {}),
    };
    const unmetApplicationGateLimits = [publicationGate, declaredActionsGate]
      .filter((gate) => gate.applicable && !gate.met)
      .map((gate) => gate.reason);
    return writeReceipt(receiptPath, {
      evidenceClass: "installed-api",
      status: "pass",
      facility: "identify-installed-artifact",
      subject,
      revision: {
        identity: verdict.matchedIdentity.identity,
        version: verdict.matchedIdentity.version,
      },
      // Deliberately a summary, not the raw envelopes: the real status()/getSnapshot() responses can
      // carry the full live application event/state history (megabytes, and potentially real session
      // content beyond what lib/redact.mjs's secret-shape patterns catch) — this receipt only needs to
      // prove identity/integrity/publication/declared-actions/viewport, not archive live app content.
      // F-005b (iii): `gates` names exactly which of identity/integrity/publication/declaredActions were
      // verified vs unmet — a partial catalog read is never labeled full artifact/application acceptance.
      proof: {
        instanceScope,
        sessionScope,
        target,
        matchedIdentity: {
          identity: verdict.matchedIdentity.identity,
          version: verdict.matchedIdentity.version,
          candidateId: verdict.matchedIdentity.candidateId,
          catalogEntryId: verdict.matchedIdentity.catalogEntryId,
          status: verdict.matchedIdentity.status,
          diagnostics: verdict.matchedIdentity.diagnostics ?? [],
        },
        discoveryStatus: status.value?.discoveryStatus,
        installedItemCount: Array.isArray(status.value?.items) ? status.value.items.length : 0,
        // N-FF1 + L2R-001: no descriptor fields are echoed here — the instance's content.descriptor is
        // an open-time snapshot and is never consulted for actions; gates.declaredActions carries the
        // publication-side declaredActions/declaredTools instead.
        matchedInstance: verdict.matchedInstance
          ? {
              instanceId: verdict.matchedInstance.instanceId,
              owner: verdict.matchedInstance.owner,
              surface: verdict.matchedInstance.surface,
            }
          : null,
        geometry,
        gates,
      },
      limits: [
        "success/value envelope only proves the API responded and named identity was found; visual " +
          "correctness is the installed-ui receipt's job.",
        "proof is a summary of the real envelopes, not their full raw content — the live snapshot's " +
          "event history and application state are excluded to avoid embedding live app/session content " +
          "in a checked-in receipt.",
        "See proof.gates for exactly which of identity/integrity/publication/declaredActions were verified " +
          "vs unmet this run — an unmet application-level gate does not by itself flip this receipt to " +
          '"fail" (identity + integrity are the only gates required for a "pass"), but is never claimed verified.',
        ...verdict.limits,
        ...geometryLimits,
        ...unmetApplicationGateLimits,
      ],
    });
  } catch (error) {
    const isConnectionRefusal = error instanceof LiveConnectionRefusalError;
    // L2-005: a typed scope-discovery refusal (an unresolvable operator-pinned override, or multiple open
    // sessions each owning a matching instance with no override to disambiguate) is the same "honestly
    // declined rather than guessed" class as the connection guards above — reported "blocked", never "fail".
    const isScopeRefusal = error instanceof ScopeDiscoveryRefusalError;
    const isRefusal = isConnectionRefusal || isScopeRefusal;
    return writeReceipt(receiptPath, {
      evidenceClass: "installed-api",
      // F-DEPLOY-2 (b)/(c): a typed connection-guard refusal (missing explicit port, non-Marshal
      // endpoint, no confident page match) is reported "blocked", not "fail" — it means this facility
      // honestly declined to attach, the same status class as the other operator-configuration gaps
      // above, not a claim that a real check ran and found something wrong.
      status: isRefusal ? "blocked" : "fail",
      facility: "identify-installed-artifact",
      subject,
      reason: error instanceof Error ? error.message : String(error),
      ...(isConnectionRefusal ? { proof: { refusalCode: error.code } } : {}),
      ...(isScopeRefusal
        ? { proof: { refusalCode: error.code, candidates: error.candidates } }
        : {}),
    });
  } finally {
    await client?.close();
  }
}

async function main() {
  const kernelMock = await kernelMockIdentity();
  const installedApi = await installedApiIdentity();
  process.stdout.write(`${JSON.stringify({ kernelMock, installedApi }, null, 2)}\n`);
  process.exitCode = [kernelMock, installedApi].some((receipt) => receipt.status === "fail")
    ? 1
    : 0;
}

main();
