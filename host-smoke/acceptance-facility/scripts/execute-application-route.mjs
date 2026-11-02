#!/usr/bin/env node
// D4, point (b): real application execution
// (AUDIT-VERDICT-AND-ACCEPTANCE.md "Testing capability gaps", point 2).
// kernel-mock: proves the declare -> grant / undeclared -> deny shape using
// a declared-only permission broker (never allow-all — see
// lib/declared-permission-broker.mjs). installed-api: drives the real
// authenticated application route (window.runtimeUiAPI.invokeCapability)
// against production activation under NORMAL policy — live-app only.
//
// F-005 repair (b): the documented live request shape omitted
// publicationRevisionId (common/runtime-ui.ts's
// RuntimeUiApplicationCapabilityInvokeCommand). Packaged HTML applications
// gated by a live publication deny an invoke whose publicationRevisionId
// doesn't match the CURRENT one ("This application bundle is stale" —
// electron/ipc/runtime-ui-ipc.ts). This now fetches the current revisionId
// itself via runtime-ui:getSnapshot + runtime-ui:readResource when the
// operator didn't already supply one, instead of only documenting the gap.
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findInvokeTargetResourceUri,
  verifyInvokeResult,
  verifyLiveInvokeRequest,
} from "../lib/capability-invoke-verification.mjs";
import { withSampleAppKernel } from "../lib/kernel-mock-harness.mjs";
import {
  connectToRunningMarshal,
  evaluateInRenderer,
  LiveConnectionRefusalError,
  liveModePort,
  liveModeRequested,
} from "../lib/live-connection.mjs";
import { writeReceipt } from "../lib/receipt.mjs";
import { createSampleAppCapabilityProvider } from "../sample-app/capability-provider.mjs";
import {
  SAMPLE_APP_CAPABILITY_NAME,
  SAMPLE_APP_DECLARED_PERMISSION,
  SAMPLE_APP_UNDECLARED_PERMISSION,
  sampleAppManifest,
} from "../sample-app/manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.resolve(__dirname, "..", "example-receipts");

async function kernelMockExecution() {
  const manifest = sampleAppManifest();

  const declaredResult = await withSampleAppKernel(
    createSampleAppCapabilityProvider(),
    [SAMPLE_APP_DECLARED_PERMISSION],
    (kernel, ctx) =>
      kernel.runtimeExec(
        { protocolVersion: "1.0", target: SAMPLE_APP_CAPABILITY_NAME, input: { page: 1 } },
        ctx(),
      ),
  );
  const undeclaredResult = await withSampleAppKernel(
    createSampleAppCapabilityProvider(),
    [SAMPLE_APP_UNDECLARED_PERMISSION],
    (kernel, ctx) =>
      kernel.runtimeExec(
        { protocolVersion: "1.0", target: SAMPLE_APP_CAPABILITY_NAME, input: { page: 1 } },
        ctx(),
      ),
  );

  const declaredAllowed = declaredResult.status === "success";
  const undeclaredDenied =
    undeclaredResult.status === "denied" && undeclaredResult.error?.code === "permission_denied";

  return writeReceipt(path.join(RECEIPTS_DIR, "execute-application-route.kernel-mock.json"), {
    evidenceClass: "kernel-mock",
    status: declaredAllowed && undeclaredDenied ? "pass" : "fail",
    facility: "execute-application-route",
    subject: `Invoke ${SAMPLE_APP_CAPABILITY_NAME} under a declared-only permission broker (no allow-all)`,
    revision: { identity: manifest.identity, version: manifest.version },
    reason:
      declaredAllowed && undeclaredDenied
        ? undefined
        : "Declare/deny shape did not hold — see proof.",
    proof: {
      declaredPermissionCase: {
        permission: SAMPLE_APP_DECLARED_PERMISSION,
        result: declaredResult,
      },
      undeclaredPermissionCase: {
        permission: SAMPLE_APP_UNDECLARED_PERMISSION,
        result: undeclaredResult,
      },
    },
    limits: [
      "This is the RuntimeKernel contribution/permission-broker contract only. It is NOT the real per-session " +
        "PermissionPolicy/approval UX (electron/permission-policy.ts) and does NOT exercise NORMAL policy. " +
        "See the installed-api receipt for what only the live app + real policy can prove.",
    ],
  });
}

async function installedApiExecution() {
  const receiptPath = path.join(RECEIPTS_DIR, "execute-application-route.installed-api.json");
  if (!liveModeRequested()) {
    return writeReceipt(receiptPath, {
      evidenceClass: "installed-api",
      status: "blocked",
      facility: "execute-application-route",
      subject:
        "Authenticated application route via window.runtimeUiAPI.invokeCapability under NORMAL policy",
      reason:
        "Requires parent deployment step / live authorization: set ACCEPTANCE_FACILITY_ALLOW_LIVE=1 and run " +
        "against an already-running Marshal with a CDP debug port open, an installed application instance, " +
        "and an active session under NORMAL policy. This facility never bypasses or replaces the real " +
        "PermissionPolicy with an allow-all test broker.",
      limits: [
        "The caller must supply a real instance/capability/session via ACCEPTANCE_FACILITY_LIVE_INVOKE " +
          "(JSON: {applicationScope, workspaceName, extensionId, applicationId, instanceId, capability, " +
          "input, idempotencyKey, publicationRevisionId}) — this facility does not invent one. " +
          "publicationRevisionId is optional in the request; when omitted this script fetches the CURRENT " +
          "one itself via runtime-ui:getSnapshot + runtime-ui:readResource before invoking.",
      ],
    });
  }
  const rawInvokeRequest = process.env.ACCEPTANCE_FACILITY_LIVE_INVOKE?.trim();
  if (!rawInvokeRequest) {
    return writeReceipt(receiptPath, {
      evidenceClass: "installed-api",
      status: "blocked",
      facility: "execute-application-route",
      subject:
        "Authenticated application route via window.runtimeUiAPI.invokeCapability under NORMAL policy",
      reason:
        "ACCEPTANCE_FACILITY_ALLOW_LIVE=1 was set but ACCEPTANCE_FACILITY_LIVE_INVOKE was not provided — " +
        "no capability request to drive against production activation.",
    });
  }
  // SF-4: operator-authored local invocation request, not externally supplied data.
  const invokeRequest = JSON.parse(rawInvokeRequest);
  const requestValidity = verifyLiveInvokeRequest(invokeRequest);
  if (!requestValidity.ok) {
    return writeReceipt(receiptPath, {
      evidenceClass: "installed-api",
      status: "fail",
      facility: "execute-application-route",
      subject:
        "Authenticated application route via window.runtimeUiAPI.invokeCapability under NORMAL policy",
      reason: requestValidity.reason,
    });
  }
  let client;
  try {
    const port = liveModePort();
    ({ client } = await connectToRunningMarshal(port));
    let publicationRevisionId = invokeRequest.publicationRevisionId;
    let revisionSource = publicationRevisionId ? "operator-supplied" : undefined;
    if (!publicationRevisionId) {
      const scope = {
        sessionId: invokeRequest.sessionId,
        workspaceName: invokeRequest.workspaceName,
        applicationScope: invokeRequest.applicationScope,
      };
      const snapshotJson = await evaluateInRenderer(
        client,
        `window.runtimeUiAPI.getSnapshot(${JSON.stringify(scope)}).then((r) => JSON.stringify(r))`,
      );
      const snapshot = JSON.parse(snapshotJson);
      const resourceUri = snapshot?.success
        ? findInvokeTargetResourceUri(snapshot.value?.instances, invokeRequest)
        : undefined;
      if (resourceUri) {
        const readRequest = {
          sessionId: invokeRequest.sessionId,
          workspaceName: invokeRequest.workspaceName,
          applicationScope: invokeRequest.applicationScope,
          extensionId: invokeRequest.extensionId,
          applicationId: invokeRequest.applicationId,
          instanceId: invokeRequest.instanceId,
          uri: resourceUri,
        };
        const resourceJson = await evaluateInRenderer(
          client,
          `window.runtimeUiAPI.readResource(${JSON.stringify(readRequest)}).then((r) => JSON.stringify(r))`,
        );
        const resource = JSON.parse(resourceJson);
        if (resource?.success && resource.value?.revisionId) {
          publicationRevisionId = resource.value.revisionId;
          revisionSource = "fetched via runtime-ui:readResource";
        }
      }
    }
    const liveInvokeRequest = publicationRevisionId
      ? { ...invokeRequest, publicationRevisionId }
      : invokeRequest;
    const resultJson = await evaluateInRenderer(
      client,
      `window.runtimeUiAPI.invokeCapability(${JSON.stringify(liveInvokeRequest)}).then((r) => JSON.stringify(r))`,
    );
    const result = JSON.parse(resultJson);
    const resultVerdict = verifyInvokeResult(result);
    return writeReceipt(receiptPath, {
      evidenceClass: "installed-api",
      status: resultVerdict.ok ? "pass" : "fail",
      facility: "execute-application-route",
      subject: `Invoke ${invokeRequest.capability} under NORMAL policy against production activation`,
      reason: resultVerdict.ok ? undefined : resultVerdict.reason,
      proof: {
        request: { ...liveInvokeRequest, input: "[REDACTED capability input]" },
        publicationRevisionIdSource: revisionSource ?? "none available",
        result,
      },
      limits: [
        "Capability inputs are redacted in this receipt by policy, not just by pattern-matching.",
        ...requestValidity.limits,
      ],
    });
  } catch (error) {
    const isRefusal = error instanceof LiveConnectionRefusalError;
    return writeReceipt(receiptPath, {
      evidenceClass: "installed-api",
      // F-DEPLOY-2 (b)/(c): a typed connection-guard refusal is reported "blocked", not "fail" — see
      // identify-installed-artifact.mjs for the same convention.
      status: isRefusal ? "blocked" : "fail",
      facility: "execute-application-route",
      subject: `Invoke ${invokeRequest.capability} under NORMAL policy against production activation`,
      reason: error instanceof Error ? error.message : String(error),
      ...(isRefusal ? { proof: { refusalCode: error.code } } : {}),
    });
  } finally {
    await client?.close();
  }
}

async function main() {
  const kernelMock = await kernelMockExecution();
  const installedApi = await installedApiExecution();
  process.stdout.write(`${JSON.stringify({ kernelMock, installedApi }, null, 2)}\n`);
  process.exitCode = [kernelMock, installedApi].some((receipt) => receipt.status === "fail")
    ? 1
    : 0;
}

main();
