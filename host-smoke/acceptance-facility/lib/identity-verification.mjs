// F-005 (a) repair: the pass/fail decision for identify-installed-artifact.mjs's
// installed-api receipt, extracted as pure logic so it is unit-testable without
// a live Marshal. A pass is impossible unless: a real scope was discovered, both
// IPC envelopes report success:true, and the target extension's identity/version
// were actually found in the status response. Missing any of these writes a
// "fail" (not a downgraded "blocked" and never a "pass") — see repair (d).
//
// F-005b repair (Defect 1): the previous `.find` matched on identity OR
// candidateId string alone, accepted any status (including "detected" — no
// integrity, not installed, not enabled) and never checked integrity, so a
// stale/older detected candidate could shadow the actually-installed one and
// the receipt's limits text overclaimed that integrity/publication/declared
// actions "were still verified" when they were never checked. This now (i)
// requires the matched candidate's status to be exactly "installed-enabled"
// AND an independently-recomputed integrity hash that matches an
// operator-pinned expected value (computeRuntimeExtensionIntegrity — the
// same package-tree digest the runtime itself enforces on install/load), (ii)
// verifies the target application's CURRENT publication (a live
// runtime-ui:readResource of its resource) and declared actions when an
// applicationId was targeted, and (iii) reports each gate's met/unmet state
// individually instead of one blanket claim.
//
// N-FF1 + L2R-001 repair: the declared-actions gate now reads the PUBLICATION
// application record (runtime-ui:getPlacements) instead of the matched
// instance's content.descriptor — see verifyDeclaredActions below for the
// adjudicated mechanism (instance descriptor = open-time snapshot, never
// refreshed; publication record = authoritative update-current surface).
import { computeRuntimeExtensionIntegrity } from "@marshal/agent-runtime-extensions";

export function verifyInstalledIdentity({ scope, target, status, snapshot }) {
  if (!scope) {
    return {
      ok: false,
      reason:
        "No real session/workspace scope was discoverable from window.sessionsAPI.list() — refusing to " +
        "call runtime-extensions:status/runtime-ui:getSnapshot with an empty scope (that previously returned " +
        "success:false silently treated as a pass).",
    };
  }
  if (!target || typeof target.identity !== "string" || !target.identity.trim()) {
    return {
      ok: false,
      reason:
        "No explicit target extension identity was provided (ACCEPTANCE_FACILITY_LIVE_TARGET). This facility " +
        "never guesses which installed extension to identify.",
    };
  }
  if (!status?.success) {
    return {
      ok: false,
      reason: `runtime-extensions:status did not succeed: ${describeEnvelopeError(status?.error)}`,
    };
  }
  if (!snapshot?.success) {
    return {
      ok: false,
      reason: `runtime-ui:getSnapshot did not succeed: ${describeEnvelopeError(snapshot?.error)}`,
    };
  }
  const items = Array.isArray(status.value?.items) ? status.value.items : [];
  const identityMatches = items.filter((item) => item?.identity === target.identity);
  const enabledInstalledMatches = identityMatches.filter(
    (item) => item?.status === "installed-enabled",
  );
  if (enabledInstalledMatches.length === 0) {
    const seenStatuses =
      identityMatches
        .map((item) => item.status)
        .filter(Boolean)
        .join(", ") || "no candidate with this identity was present at all";
    return {
      ok: false,
      reason:
        `No ENABLED, INSTALLED extension matched identity ${JSON.stringify(target.identity)} — status must ` +
        `be exactly "installed-enabled" (found: ${seenStatuses}). A merely-detected candidate, a disabled ` +
        "install, or an in-progress install can never satisfy this gate, even when its identity string matches.",
    };
  }
  // Exact identity + installed-enabled status is unambiguous in practice (the runtime projects at most one
  // installed-enabled item per identity); if duplicates ever appear, still deterministically pick the first
  // rather than silently ignoring the ambiguity.
  const matchedIdentity = enabledInstalledMatches[0];
  if (!matchedIdentity.version) {
    return {
      ok: false,
      reason: `The matched installed-enabled entry for ${target.identity} is missing a version.`,
    };
  }
  const integrityGate = verifyMatchedIntegrity(matchedIdentity, target);
  if (!integrityGate.met) {
    return { ok: false, reason: integrityGate.reason };
  }
  const instances = Array.isArray(snapshot.value?.instances) ? snapshot.value.instances : [];
  const matchedInstance = target.applicationId
    ? instances.find(
        (instance) =>
          instance?.owner?.extensionId === target.identity &&
          instance?.owner?.applicationId === target.applicationId,
      )
    : undefined;
  return {
    ok: true,
    matchedIdentity,
    matchedInstance,
    gates: {
      identity: { met: true },
      integrity: {
        met: true,
        algorithm: integrityGate.algorithm,
        domain: integrityGate.domain,
        value: integrityGate.value,
      },
    },
    limits: matchedInstance
      ? []
      : [
          "No open application instance matched the target application ID — iframe geometry, current " +
            "publication, and declared actions were not captured this run (only identity + integrity were).",
        ],
  };
}

/**
 * F-005b (i): integrity is only "verified" when this facility independently recomputes the package-tree
 * digest from disk (the real production check — computeRuntimeExtensionIntegrity, same function
 * electron/marshal-runtime install/load paths use) AND it matches a value the operator pinned in the
 * target descriptor. An "installed-enabled" status alone is never treated as integrity proof.
 */
function verifyMatchedIntegrity(matchedIdentity, target) {
  if (
    !target.expectedIntegrity ||
    typeof target.expectedIntegrity !== "string" ||
    !target.expectedIntegrity.trim()
  ) {
    return {
      met: false,
      reason:
        "No expected integrity hash was supplied (ACCEPTANCE_FACILITY_LIVE_TARGET.expectedIntegrity). This " +
        "facility never treats an installed-enabled status alone as integrity proof — an independently-known " +
        "sha256 package digest must be pinned to compare against.",
    };
  }
  if (!matchedIdentity.packageRoot || typeof matchedIdentity.packageRoot !== "string") {
    return {
      met: false,
      reason:
        `The matched installed-enabled entry for ${JSON.stringify(matchedIdentity.identity)} carries no ` +
        "packageRoot in the status response, so this facility cannot independently recompute its integrity " +
        "hash from disk.",
    };
  }
  let computed;
  try {
    computed = computeRuntimeExtensionIntegrity(matchedIdentity.packageRoot);
  } catch (error) {
    return {
      met: false,
      reason: `Failed to independently recompute integrity for ${matchedIdentity.packageRoot}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (computed.value !== target.expectedIntegrity) {
    return {
      met: false,
      reason:
        `Independently recomputed integrity (${computed.value}) does not match the expected pinned value ` +
        `(${target.expectedIntegrity}) for ${matchedIdentity.packageRoot}.`,
    };
  }
  return {
    met: true,
    algorithm: computed.algorithm,
    domain: computed.domain,
    value: computed.value,
  };
}

/**
 * F-005b (ii): "verify THAT target's CURRENT publication" — confirms the matched instance's application
 * resource still resolves via a live runtime-ui:readResource and carries a revisionId, rather than assuming
 * the snapshot descriptor alone proves the published bundle is current. Only applicable when an
 * applicationId was targeted; explicitly reports "unmet" (never silently "verified") when it cannot run.
 * @param {{target: object, matchedInstance: object | undefined, resource: {success?: boolean, error?: unknown, value?: {revisionId?: string}} | undefined}} args
 */
export function verifyApplicationPublication({ target, matchedInstance, resource }) {
  if (!target?.applicationId) return { applicable: false };
  if (!matchedInstance) {
    return {
      applicable: true,
      met: false,
      reason:
        "No open application instance matched the target application ID — current publication could not be " +
        "verified this run.",
    };
  }
  if (!resource?.success || !resource.value?.revisionId) {
    return {
      applicable: true,
      met: false,
      reason:
        `Could not confirm the CURRENT published revision for ${target.applicationId}: ` +
        (resource?.success === false
          ? describeEnvelopeError(resource.error)
          : "runtime-ui:readResource returned no revisionId."),
    };
  }
  return { applicable: true, met: true, revisionId: resource.value.revisionId };
}

/**
 * Extracts the publication application record for the target extension/application from a
 * runtime-ui:getPlacements snapshot (the renderer-bridge projection of the publication service's live
 * listApplications — the same applicationById the getPlacements handler resolves in
 * electron/ipc/runtime-ui-ipc.ts). Pure and deterministic; returns null when the target application is
 * not referenced by any placement in the snapshot (not published, or published without a placement
 * registration — verifyDeclaredActions reports that honestly, never guesses).
 * @param {{snapshot: {placements?: readonly {applications?: readonly object[]}[]} | undefined, target: {identity: string, applicationId?: string}}} args
 */
export function findPublishedApplicationRecord({ snapshot, target }) {
  if (!target?.identity || !target.applicationId) return null;
  const placements = Array.isArray(snapshot?.placements) ? snapshot.placements : [];
  for (const placement of placements) {
    const applications = Array.isArray(placement?.applications) ? placement.applications : [];
    const match = applications.find(
      (application) =>
        application?.extensionId === target.identity &&
        application?.applicationId === target.applicationId,
    );
    if (match) return match;
  }
  return null;
}

/**
 * N-FF1 + L2R-001 repair: "verify... declared actions" — the actions evidence now comes from the
 * PUBLICATION application record (the runtime-ui:getPlacements projection, resolved live from the
 * publication service's listApplications), never from the matched instance's content.descriptor.
 * Two adjudicated defects made the previous gate structurally unmeetable:
 *   - N-FF1: it read `descriptor.declaredActions`, a field no product surface ever emits — the real
 *     UiApplicationManifest fields are `actions[]` (entries with `id`) and `tools[]` (entries with
 *     `name`); see node_modules/@marshal/agent-runtime-ui/dist/applicationTypes.d.ts.
 *   - L2R-001 (adjudicated): even with the right field name, the instance's content.descriptor is an
 *     OPEN-TIME SNAPSHOT of the publication manifest frozen at controller.open
 *     (electron/marshal-runtime/ui-controller.ts:846-900), persisted for user-scope instances and never
 *     refreshed on extension update — arbitrarily stale. The publication application record is the
 *     authoritative update-current surface.
 * N-FF1b (composition): the getPlacements bridge projection FLATTENS the published manifest onto the
 * placement application entry itself — toDesktopPlacementApplication (electron/ipc/runtime-ui-ipc.ts)
 * emits top-level `actions[]` (entries with `id`), `tools[]` (entries with `name`) and `revisionId`;
 * there is no nested `application` manifest over this bridge. This gate reads exactly that shape (no
 * dual-shape guessing); an entry genuinely lacking both top-level fields — the bridge omits them when
 * the published record carries no manifest — stays honestly unmet.
 * The matched instance still anchors WHICH application/owner is checked (no instance → honest unmet);
 * it is never consulted for the actions themselves. Reads-but-does-not-verify (explicitly unmet, not
 * "verified") when no expected set was supplied, per F-005b (iii)'s "never label a partial read as
 * full acceptance." Optional `target.expectedDeclaredTools` is checked against the publication
 * record's tools[].name the same way.
 * @param {{target: object, matchedInstance: object | undefined, publication: {success?: boolean, error?: unknown, record?: object | null} | undefined}} args
 */
export function verifyDeclaredActions({ target, matchedInstance, publication }) {
  if (!target?.applicationId) return { applicable: false };
  if (!matchedInstance) {
    return {
      applicable: true,
      met: false,
      reason:
        "No open application instance matched the target application ID — there is no anchored " +
        "application/owner whose publication-declared actions could be verified this run.",
    };
  }
  if (!publication?.success) {
    return {
      applicable: true,
      met: false,
      reason:
        "The publication surface could not be read (runtime-ui:getPlacements): " +
        describeEnvelopeError(publication?.error) +
        " — declared actions are only ever verified against the publication application record, never " +
        "against the instance's open-time descriptor snapshot (L2R-001).",
    };
  }
  if (!publication.record) {
    return {
      applicable: true,
      met: false,
      reason:
        `The publication surface listed no application record for ${target.identity}/` +
        `${target.applicationId} — the application is not currently published (or is not referenced by ` +
        "any placement in this scope), so its declared actions cannot be verified.",
    };
  }
  // N-FF1b: read the ACTUAL bridge shape — top-level actions[]/tools[] on the placement application
  // entry (toDesktopPlacementApplication spreads the published manifest's fields onto the entry and
  // omits both when the record carries no manifest).
  const record = publication.record;
  const hasActionsField = Array.isArray(record.actions);
  const hasToolsField = Array.isArray(record.tools);
  if (!hasActionsField && !hasToolsField) {
    return {
      applicable: true,
      met: false,
      reason:
        "The publication application record carried no top-level actions[]/tools[] fields over this " +
        "bridge projection (runtime-ui:getPlacements omits them when the published record has no " +
        "manifest) — the publication-declared actions could not be read this run, so this gate is " +
        "honestly unmet, never assumed from the instance's open-time descriptor snapshot.",
    };
  }
  const declaredActions = hasActionsField
    ? record.actions.map((action) => action?.id).filter((id) => typeof id === "string")
    : [];
  const declaredTools = hasToolsField
    ? record.tools.map((tool) => tool?.name).filter((name) => typeof name === "string")
    : [];
  if (declaredActions.length === 0 && declaredTools.length === 0) {
    return {
      applicable: true,
      met: false,
      reason: "The publication application record declares no actions and no tools to verify.",
    };
  }
  if (!Array.isArray(target.expectedDeclaredActions)) {
    return {
      applicable: true,
      met: false,
      declaredActions,
      declaredTools,
      reason:
        "No expectedDeclaredActions was supplied (ACCEPTANCE_FACILITY_LIVE_TARGET.expectedDeclaredActions) " +
        "— the publication-declared actions were read but not verified against an expected set.",
    };
  }
  const actionsMatch = setsEqual(target.expectedDeclaredActions, declaredActions);
  const toolsApplicable = Array.isArray(target.expectedDeclaredTools);
  const toolsMatch = toolsApplicable
    ? setsEqual(target.expectedDeclaredTools, declaredTools)
    : true;
  const matches = actionsMatch && toolsMatch;
  const reasons = [];
  if (!actionsMatch) {
    reasons.push(
      `Publication-declared action ids ${JSON.stringify(declaredActions)} do not match the expected ` +
        `set ${JSON.stringify(target.expectedDeclaredActions)}.`,
    );
  }
  if (!toolsMatch) {
    reasons.push(
      `Publication-declared tool names ${JSON.stringify(declaredTools)} do not match the expected ` +
        `set ${JSON.stringify(target.expectedDeclaredTools)}.`,
    );
  }
  return {
    applicable: true,
    met: matches,
    declaredActions,
    declaredTools,
    ...(typeof publication.record.revisionId === "string"
      ? { revisionId: publication.record.revisionId }
      : {}),
    reason: matches ? undefined : reasons.join(" "),
  };
}

function setsEqual(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return expectedSet.size === actualSet.size && [...expectedSet].every((id) => actualSet.has(id));
}

function describeEnvelopeError(error) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") return JSON.stringify(error);
  return "unknown error";
}
