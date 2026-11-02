// F-005 (a) repair: identify-installed-artifact.mjs previously called
// window.runtimeExtensionsAPI.status({}) / window.runtimeUiAPI.getSnapshot({})
// with an EMPTY scope — both actually return success:false against a running
// Marshal ("Invalid Runtime extension request.", "Workspace name is
// required.": electron/ipc/runtime-extensions-ipc.ts's validScope,
// electron/marshal-runtime/ui-controller.ts's requiredString). Both IPC
// contracts require a real, non-empty { sessionId, workspaceName } scope.
// This module picks one from the live renderer's own session list
// (window.sessionsAPI.list()) instead of inventing or hardcoding one.
//
// L2-005 repair: picking ONE scope (the active, else the first, session) and
// assuming that session's workspace owns every open application instance is
// itself wrong whenever the target's pane is open under a DIFFERENT session
// — runtime-ui:getSnapshot(scope) filters instances by that exact
// {sessionId, workspaceName} pair (electron/marshal-runtime/ui-controller.ts's
// scopedInstances()/sameScope()), so an auto-picked scope that doesn't own the
// open instance always reports matchedInstance:null even with the pane
// visibly open (live-reproduced: verification/l2/l2-1-identify-code-review-v2-facility.json
// auto-picked {workspaceName:"marshal-host"} while the codereview.prs pane
// was open elsewhere). `selectLiveScope` below is kept byte-identical (still
// used when no application target was given — there is nothing to
// disambiguate by) but is no longer the only path: `selectScopeForIdentify`
// enumerates every open session's own snapshot for the target instance and
// only ever trusts an unambiguous match, an operator-pinned override, or
// refuses with a typed reason — never a guess.
//
// L2-005 RESIDUAL (branch (ii), reviewer-found in review-facility-tip,
// planner-routed): a NAV-OPENED pane instance (opened from the primary nav,
// not a chat session) registers under the PERSISTENT USER SCOPE
// {applicationScope:"user", workspaceName:"marshal"}
// (src/features/runtime-ui/RuntimeUiNavigation.tsx:60-67,
// common/runtime-ui.ts:251-254's RUNTIME_UI_USER_SCOPE) — a scope key
// ["user", null, "marshal"] that can never equal any session candidate's
// ["session", sessionId, workspaceName] (electron/marshal-runtime/
// ui-controller.ts's sameScope()/runtimeUiScopeKey()), so every per-session
// enumeration above always missed it, even with the pane visibly open
// (verification/identify-l2005-live-scopefix-residual.json). The bridge is
// reachable though: runtime-ui:getSnapshot/:readResource accept a persistent
// {applicationScope, workspaceName} request with no session requirement
// (electron/ipc/runtime-ui-ipc.ts:192-195, :552-583's published-application
// branch, :748-763's requireApplicationInstance) — the SAME calls this module
// already makes, just never aimed at that scope. This module now adds the
// persistent user scope as an additional enumeration candidate alongside the
// per-session ones, with an applicationScope-aware scope key. Persistent
// *workspace*-scoped candidates ({applicationScope:"workspace", ...}) are a
// real, structurally identical concept (electron/marshal-runtime/
// ui-controller.ts's normalizeScope treats "user"/"workspace" symmetrically)
// but are NOT yet enumerated here — no known defect currently reaches through
// one, and the objective marks this extension optional; call this out as an
// accepted limit rather than guessing at it.
//
// `runtimeExtensionsAPI.status` (the identity/integrity gate) still requires
// a session scope (electron/ipc/runtime-extensions-ipc.ts's validScope) —
// only runtime-ui:getSnapshot/readResource/geometry can resolve to the
// persistent scope. Callers must therefore carry TWO scopes: `sessionScope`
// (session-only, for status()) and `instanceScope` (may be persistent, for
// getSnapshot/readResource/geometry) — see discoverLiveScope's return shape.
//
// Pure decision logic lives here (selectLiveScope, resolveScopeOverride,
// selectInstanceOwningScopes, selectScopeForIdentify) so it is unit-testable
// without a live Marshal or network access; discoverLiveScope is the thin,
// untested CDP-calling wrapper around it.

/**
 * The persistent scope nav-opened application instances register under —
 * common/runtime-ui.ts's RUNTIME_UI_USER_SCOPE / MARSHAL_RUNTIME_DEFAULT_WORKSPACE. This facility
 * cannot import that module (it runs standalone, outside the electron/src module graph), so the
 * literal "marshal" workspace name is duplicated here deliberately — it is a fixed constant on the
 * source side, not a value this facility could discover live.
 * @type {{applicationScope: "user", workspaceName: "marshal"}}
 */
export const PERSISTENT_USER_SCOPE = Object.freeze({
  applicationScope: "user",
  workspaceName: "marshal",
});

/**
 * @param {{success?: boolean, sessions?: Array<{id?: unknown, workspaceName?: unknown, isActive?: unknown}>}} sessionsListResponse
 * @returns {Array<{sessionId: string, workspaceName: string, isActive: boolean}>}
 */
export function scopeCandidatesFromSessions(sessionsListResponse) {
  const sessions = Array.isArray(sessionsListResponse?.sessions)
    ? sessionsListResponse.sessions
    : [];
  return sessions
    .filter(
      (session) =>
        typeof session?.id === "string" &&
        session.id.trim().length > 0 &&
        typeof session?.workspaceName === "string" &&
        session.workspaceName.trim().length > 0,
    )
    .map((session) => ({
      sessionId: session.id,
      workspaceName: session.workspaceName,
      isActive: session.isActive === true,
    }));
}

/**
 * @param {{success?: boolean, sessions?: Array<{id?: unknown, workspaceName?: unknown, isActive?: unknown}>}} sessionsListResponse
 * @returns {{sessionId: string, workspaceName: string} | null}
 */
export function selectLiveScope(sessionsListResponse) {
  const candidates = scopeCandidatesFromSessions(sessionsListResponse);
  if (candidates.length === 0) return null;
  const active = candidates.find((candidate) => candidate.isActive);
  const chosen = active ?? candidates[0];
  return { sessionId: chosen.sessionId, workspaceName: chosen.workspaceName };
}

/**
 * L2-005 residual: applicationScope-aware. A persistent candidate (applicationScope set) never
 * carries a sessionId, so its key is distinguished by applicationScope rather than sessionId — this
 * cannot collide with a real session key unless a live sessionId were literally the string "user" or
 * "workspace", which the runtime never issues (session IDs are generated UUIDs).
 */
function scopeKey(scope) {
  if (scope.applicationScope) return `${scope.applicationScope}::${scope.workspaceName}`;
  return `${scope.sessionId}::${scope.workspaceName}`;
}

/** Strips helper fields (e.g. isActive) down to the plain scope shape a caller can pass to the IPC APIs. */
function scopeOf(candidate) {
  return candidate.applicationScope
    ? { applicationScope: candidate.applicationScope, workspaceName: candidate.workspaceName }
    : { sessionId: candidate.sessionId, workspaceName: candidate.workspaceName };
}

/**
 * L2-005 residual: candidates considered only when an applicationId target is being disambiguated —
 * see this module's doc comment for why only the persistent USER scope is enumerated (workspace-scoped
 * candidates are a documented, deliberate omission).
 * @returns {Array<{applicationScope: "user", workspaceName: string}>}
 */
function persistentScopeCandidates() {
  return [{ ...PERSISTENT_USER_SCOPE }];
}

/**
 * L2-005 repair: {sessionId?, workspaceName?} an operator can pin in
 * ACCEPTANCE_FACILITY_LIVE_TARGET.scopeOverride when they already know which
 * open session/workspace owns the instance they want to identify — this
 * bypasses automatic candidate search entirely. A supplied override that does
 * not resolve to exactly one currently-open session is a typed refusal, never
 * a silent fallback to auto-discovery (same no-guess principle as the
 * endpoint/page connection guards in lib/live-connection.mjs).
 * L2-005 residual: `override` may also carry `applicationScope` ("user") to pin a persistent scope
 * candidate instead of a session — required whenever workspaceName/sessionId alone would otherwise be
 * ambiguous between a session and a persistent candidate.
 * @param {Array<{sessionId?: string, workspaceName: string, applicationScope?: string}>} candidates
 * @param {{sessionId?: unknown, workspaceName?: unknown, applicationScope?: unknown} | null | undefined} override
 * @returns {{provided: false} | {provided: true, ok: true, scope: {sessionId: string, workspaceName: string} | {applicationScope: string, workspaceName: string}} | {provided: true, ok: false, reason: string}}
 */
export function resolveScopeOverride(candidates, override) {
  if (override === null || override === undefined) return { provided: false };
  const applicationScope =
    typeof override.applicationScope === "string" && override.applicationScope.trim().length > 0
      ? override.applicationScope.trim()
      : undefined;
  const sessionId =
    typeof override.sessionId === "string" && override.sessionId.trim().length > 0
      ? override.sessionId.trim()
      : undefined;
  const workspaceName =
    typeof override.workspaceName === "string" && override.workspaceName.trim().length > 0
      ? override.workspaceName.trim()
      : undefined;
  if (applicationScope === undefined && sessionId === undefined && workspaceName === undefined) {
    return {
      provided: true,
      ok: false,
      reason:
        "ACCEPTANCE_FACILITY_LIVE_TARGET.scopeOverride was supplied but carried neither a non-empty " +
        "sessionId, workspaceName, nor applicationScope — refusing to guess which open session or " +
        "persistent scope it meant.",
    };
  }
  const matches = candidates.filter(
    (candidate) =>
      (applicationScope === undefined || candidate.applicationScope === applicationScope) &&
      (sessionId === undefined || candidate.sessionId === sessionId) &&
      (workspaceName === undefined || candidate.workspaceName === workspaceName),
  );
  if (matches.length !== 1) {
    return {
      provided: true,
      ok: false,
      reason:
        `The pinned scope override (${JSON.stringify(override)}) matched ${matches.length} of ` +
        `${candidates.length} currently-open session/persistent scope(s) instead of exactly one — ` +
        "refusing to guess.",
    };
  }
  return { provided: true, ok: true, scope: scopeOf(matches[0]) };
}

/**
 * L2-005 repair core: enumerates candidate instances across the renderer's
 * ACTUAL open panes/sessions — for every candidate scope, checks whether that
 * scope's own runtime-ui:getSnapshot instances include one owned by the
 * target identity/applicationId — instead of assuming a single blindly-picked
 * session's workspace owns everything open. L2-005 residual: `candidates` may
 * now include the persistent user-scope candidate alongside session ones.
 * @param {Array<{sessionId?: string, workspaceName: string, applicationScope?: string}>} candidates
 * @param {Record<string, Array<{owner?: {extensionId?: unknown, applicationId?: unknown}}>>} instancesByScope keyed by scopeKey()
 * @param {{identity?: unknown, applicationId?: unknown}} target
 * @returns {Array<{sessionId: string, workspaceName: string} | {applicationScope: string, workspaceName: string}>}
 */
export function selectInstanceOwningScopes(candidates, instancesByScope, target) {
  if (!target?.applicationId) return [];
  return candidates
    .filter((candidate) => {
      const instances = instancesByScope?.[scopeKey(candidate)] ?? [];
      return instances.some(
        (instance) =>
          instance?.owner?.extensionId === target.identity &&
          instance?.owner?.applicationId === target.applicationId,
      );
    })
    .map((candidate) => scopeOf(candidate));
}

/**
 * Pure decision, unit-testable without a live Marshal or network access.
 * Given the sessions list, an optional operator-pinned override, an optional
 * per-scope instance map (only consulted when the target names an
 * applicationId — there is nothing to disambiguate by otherwise), and the
 * target, decides which single scope this run trusts:
 * - an override that resolves to exactly one open session/persistent scope always wins;
 * - an override that does not resolve is a typed refusal
 *   (`scope-override-unresolvable`), never a silent fallback;
 * - with no override and no applicationId, falls back to the legacy
 *   active-else-first heuristic (nothing to disambiguate by);
 * - with no open session at all, returns a null scope (legacy behavior —
 *   there is no session to run the identity/integrity gate against either way);
 * - with no override and exactly one session OR persistent candidate whose own
 *   snapshot has the target instance, that scope is selected — the L2-005 fix,
 *   extended (residual, branch (ii)) to also enumerate the persistent user scope;
 * - with no override and NO candidate's snapshot has the target instance,
 *   falls back to the legacy heuristic (matches prior behavior: the identity
 *   gate can still run, matchedInstance stays unset downstream);
 * - with no override and MORE THAN ONE candidate's snapshot has the target
 *   instance (session and/or persistent), refuses (`multi-candidate-no-override`)
 *   listing every matching candidate rather than guessing which one the operator meant.
 * @param {{sessionsListResponse: object, override?: {sessionId?: unknown, workspaceName?: unknown, applicationScope?: unknown} | null, instancesByScope?: Record<string, Array<object>>, target?: {identity?: unknown, applicationId?: unknown}}} args
 * @returns {{ok: true, scope: {sessionId: string, workspaceName: string} | {applicationScope: string, workspaceName: string} | null, matchedVia: string} | {ok: false, code: string, reason: string, candidates: Array<object>}}
 */
export function selectScopeForIdentify({
  sessionsListResponse,
  override,
  instancesByScope,
  target,
} = {}) {
  const sessionCandidates = scopeCandidatesFromSessions(sessionsListResponse);
  // L2-005 residual: the persistent user scope only enters the candidate pool when there is a target
  // application to disambiguate — same gating as the per-session instance search below.
  const allCandidates = target?.applicationId
    ? [...sessionCandidates, ...persistentScopeCandidates()]
    : sessionCandidates;
  const overrideResult = resolveScopeOverride(allCandidates, override);
  if (overrideResult.provided) {
    if (!overrideResult.ok) {
      return {
        ok: false,
        code: "scope-override-unresolvable",
        reason: overrideResult.reason,
        candidates: allCandidates,
      };
    }
    return { ok: true, scope: overrideResult.scope, matchedVia: "override" };
  }
  if (sessionCandidates.length === 0) {
    return { ok: true, scope: null, matchedVia: "no-open-sessions" };
  }
  if (!target?.applicationId) {
    return {
      ok: true,
      scope: selectLiveScope(sessionsListResponse),
      matchedVia: "no-application-target",
    };
  }
  const owning = selectInstanceOwningScopes(allCandidates, instancesByScope ?? {}, target);
  if (owning.length === 1) {
    return { ok: true, scope: owning[0], matchedVia: "single-instance-candidate" };
  }
  if (owning.length === 0) {
    return {
      ok: true,
      scope: selectLiveScope(sessionsListResponse),
      matchedVia: "no-instance-match-fallback",
    };
  }
  return {
    ok: false,
    code: "multi-candidate-no-override",
    reason:
      `Found the target application open under ${owning.length} different scopes and ` +
      "no ACCEPTANCE_FACILITY_LIVE_TARGET.scopeOverride was supplied to disambiguate — refusing to guess. " +
      `Candidates: ${owning.map(describeScope).join(", ")}.`,
    candidates: owning,
  };
}

function describeScope(scope) {
  return scope.applicationScope
    ? `${scope.applicationScope}@${scope.workspaceName}`
    : `${scope.sessionId}@${scope.workspaceName}`;
}

export class ScopeDiscoveryRefusalError extends Error {
  constructor(code, message, candidates) {
    super(message);
    this.name = "ScopeDiscoveryRefusalError";
    this.code = code;
    this.candidates = candidates;
  }
}

/**
 * Calls window.sessionsAPI.list() in the connected renderer, then (only when
 * `target.applicationId` is set and no scope override resolved the scope
 * already) calls window.runtimeUiAPI.getSnapshot() once per open session PLUS
 * once for the persistent user scope (L2-005 residual) to find which one
 * actually owns the target's open instance, and applies
 * selectScopeForIdentify's no-guess decision. Throws ScopeDiscoveryRefusalError
 * for a typed refusal. Runs strictly after the caller's own endpoint/page
 * verification (lib/live-connection.mjs) — this function performs no
 * evaluation of its own before that guard passes.
 *
 * Returns TWO scopes, never one: `runtimeExtensionsAPI.status` (the identity/
 * integrity gate) requires a real session scope (electron/ipc/
 * runtime-extensions-ipc.ts's validScope) and can never accept the persistent
 * scope, while `runtimeUiAPI.getSnapshot`/`readResource`/geometry should use
 * whichever scope actually owns the target instance (which may be the
 * persistent one). `sessionScope` is always session-shaped (or null with no
 * open session); `instanceScope` is the scope selectScopeForIdentify decided
 * owns the target (session-shaped, persistent, or null).
 * @param {{scopeOverride?: {sessionId?: unknown, workspaceName?: unknown, applicationScope?: unknown}, identity?: unknown, applicationId?: unknown} | undefined} target
 * @returns {Promise<{instanceScope: {sessionId: string, workspaceName: string} | {applicationScope: string, workspaceName: string} | null, sessionScope: {sessionId: string, workspaceName: string} | null, matchedVia: string}>}
 */
export async function discoverLiveScope(client, evaluateInRenderer, target) {
  const rawSessions = await evaluateInRenderer(
    client,
    "window.sessionsAPI.list().then((r) => JSON.stringify(r))",
  );
  // SF-4-equivalent: this facility's own CDP round-trip of a same-process IPC response, not externally supplied.
  const sessionsListResponse = JSON.parse(rawSessions);
  const override = target?.scopeOverride;
  const sessionCandidates = scopeCandidatesFromSessions(sessionsListResponse);
  const allCandidates = target?.applicationId
    ? [...sessionCandidates, ...persistentScopeCandidates()]
    : sessionCandidates;
  const overrideResult = resolveScopeOverride(allCandidates, override);
  let instancesByScope;
  if (!overrideResult.provided && target?.applicationId && sessionCandidates.length > 0) {
    instancesByScope = {};
    // Sequential, one CDP round-trip per candidate scope (every open session, plus the persistent
    // user scope) — this connector already runs strictly sequentially post-verification
    // (lib/live-connection.mjs); no new pre-verification evaluation.
    for (const candidate of allCandidates) {
      // eslint-disable-next-line no-await-in-loop
      const rawSnapshot = await evaluateInRenderer(
        client,
        `window.runtimeUiAPI.getSnapshot(${JSON.stringify(scopeOf(candidate))}).then((r) => JSON.stringify(r))`,
      );
      // SF-4-equivalent: same-process IPC round-trip, not externally supplied.
      const snapshot = JSON.parse(rawSnapshot);
      instancesByScope[scopeKey(candidate)] = snapshot?.success
        ? (snapshot.value?.instances ?? [])
        : [];
    }
  }
  const selection = selectScopeForIdentify({
    sessionsListResponse,
    override,
    instancesByScope,
    target,
  });
  if (!selection.ok) {
    throw new ScopeDiscoveryRefusalError(selection.code, selection.reason, selection.candidates);
  }
  return {
    instanceScope: selection.scope,
    sessionScope: selectLiveScope(sessionsListResponse),
    matchedVia: selection.matchedVia,
  };
}
