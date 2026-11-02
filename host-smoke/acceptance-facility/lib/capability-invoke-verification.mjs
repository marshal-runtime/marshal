// F-005 (b)/(d) repair: pure request/result validation for
// execute-application-route.mjs's installed-api receipt, extracted so it is
// unit-testable without a live Marshal.
//
// `publicationRevisionId` (common/runtime-ui.ts's
// RuntimeUiApplicationCapabilityInvokeCommand) was missing from this script's
// documented request shape. It is required for packaged HTML applications
// gated by a live publication — electron/ipc/runtime-ui-ipc.ts denies with
// "This application bundle is stale" when it is absent or stale
// (permission-denied), so an operator omitting it silently gets a confusing
// deny rather than a documented one. This facility cannot fetch the current
// revisionId itself (no IPC surface exposes it to the renderer today), so it
// requires the operator to supply it and only WARNS (does not hard-fail) when
// absent, since not every capability is publication-gated.
const REQUIRED_TARGET_FIELDS = Object.freeze([
  "workspaceName",
  "extensionId",
  "applicationId",
  "instanceId",
  "capability",
  "idempotencyKey",
]);

export function verifyLiveInvokeRequest(invokeRequest) {
  if (!invokeRequest || typeof invokeRequest !== "object") {
    return { ok: false, reason: "No live invoke request was provided." };
  }
  const missing = REQUIRED_TARGET_FIELDS.filter(
    (field) => typeof invokeRequest[field] !== "string" || !invokeRequest[field].trim(),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Live invoke request is missing required target identity field(s): ${missing.join(", ")}.`,
    };
  }
  const limits = [];
  if (
    typeof invokeRequest.publicationRevisionId !== "string" ||
    !invokeRequest.publicationRevisionId.trim()
  ) {
    limits.push(
      "No publicationRevisionId was supplied. Packaged HTML applications gated by a live publication deny " +
        "an invoke without the CURRENT revisionId ('This application bundle is stale' — " +
        "electron/ipc/runtime-ui-ipc.ts). Non-packaged/policy-gated capabilities are unaffected.",
    );
  }
  return { ok: true, limits };
}

export function verifyInvokeResult(result) {
  if (!result?.success) {
    return {
      ok: false,
      reason: result?.error?.message ?? "invokeCapability did not succeed.",
    };
  }
  return { ok: true };
}

/**
 * Locates the invoke target's packaged-application resource URI from a
 * getSnapshot() response, so the CURRENT publicationRevisionId can be fetched
 * via runtime-ui:readResource instead of relying on the operator to supply a
 * (possibly stale) one by hand.
 */
export function findInvokeTargetResourceUri(snapshotInstances, invokeRequest) {
  const instances = Array.isArray(snapshotInstances) ? snapshotInstances : [];
  const instance = instances.find(
    (candidate) =>
      candidate?.instanceId === invokeRequest?.instanceId &&
      candidate?.owner?.extensionId === invokeRequest?.extensionId &&
      candidate?.owner?.applicationId === invokeRequest?.applicationId,
  );
  return instance?.content?.kind === "application" ? instance.content.resource?.uri : undefined;
}
