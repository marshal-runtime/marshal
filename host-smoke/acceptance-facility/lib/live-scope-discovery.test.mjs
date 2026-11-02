import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveScopeOverride,
  scopeCandidatesFromSessions,
  selectInstanceOwningScopes,
  selectLiveScope,
  selectScopeForIdentify,
} from "./live-scope-discovery.mjs";

void test("selectLiveScope returns null when no sessions carry a workspaceName", () => {
  const result = selectLiveScope({ success: true, sessions: [{ id: "s1" }, { id: "s2" }] });
  assert.equal(result, null);
});

void test("selectLiveScope returns null for an empty or malformed response", () => {
  assert.equal(selectLiveScope({ success: false }), null);
  assert.equal(selectLiveScope(null), null);
  assert.equal(selectLiveScope({ success: true, sessions: [] }), null);
});

void test("selectLiveScope prefers the active session when several qualify", () => {
  const result = selectLiveScope({
    success: true,
    sessions: [
      { id: "s1", workspaceName: "ws-a", isActive: false },
      { id: "s2", workspaceName: "ws-b", isActive: true },
    ],
  });
  assert.deepEqual(result, { sessionId: "s2", workspaceName: "ws-b" });
});

void test("selectLiveScope falls back to the first qualifying session when none is active", () => {
  const result = selectLiveScope({
    success: true,
    sessions: [
      { id: "s1", workspaceName: "ws-a" },
      { id: "s2", workspaceName: "ws-b" },
    ],
  });
  assert.deepEqual(result, { sessionId: "s1", workspaceName: "ws-a" });
});

void test("selectLiveScope ignores sessions with a blank workspaceName or id", () => {
  const result = selectLiveScope({
    success: true,
    sessions: [
      { id: "s1", workspaceName: "   " },
      { id: "  ", workspaceName: "ws-b" },
      { id: "s3", workspaceName: "ws-c" },
    ],
  });
  assert.deepEqual(result, { sessionId: "s3", workspaceName: "ws-c" });
});

// L2-005 fixtures: an instance the operator wants identified lives under a session/workspace that is NOT
// the active/first one auto-picked by selectLiveScope — the exact live shape (verification/l2/
// l2-1-identify-code-review-v2-facility.json: sessionsAPI auto-picked {workspaceName:"marshal-host"} while
// the codereview.prs pane was open under a different session's workspace, so matchedInstance was null).
const L2005_TARGET = { identity: "@marshal/code-review", applicationId: "codereview.prs" };
const L2005_SESSIONS = {
  success: true,
  sessions: [
    { id: "session-1", workspaceName: "marshal-host", isActive: true },
    { id: "session-2", workspaceName: "codereview-workspace", isActive: false },
  ],
};
const L2005_MATCHING_INSTANCE = {
  instanceId: "instance-1",
  surface: "panel",
  owner: { extensionId: L2005_TARGET.identity, applicationId: L2005_TARGET.applicationId },
};
const L2005_INSTANCES_BY_SCOPE = {
  "session-1::marshal-host": [],
  "session-2::codereview-workspace": [L2005_MATCHING_INSTANCE],
};

void test("scopeCandidatesFromSessions extracts every valid session, not just the auto-picked one", () => {
  const candidates = scopeCandidatesFromSessions(L2005_SESSIONS);
  assert.deepEqual(candidates, [
    { sessionId: "session-1", workspaceName: "marshal-host", isActive: true },
    { sessionId: "session-2", workspaceName: "codereview-workspace", isActive: false },
  ]);
});

void test("resolveScopeOverride reports not-provided when no override is given", () => {
  const candidates = scopeCandidatesFromSessions(L2005_SESSIONS);
  assert.deepEqual(resolveScopeOverride(candidates, undefined), { provided: false });
  assert.deepEqual(resolveScopeOverride(candidates, null), { provided: false });
});

void test("resolveScopeOverride resolves a workspaceName-only override to exactly one open session", () => {
  const candidates = scopeCandidatesFromSessions(L2005_SESSIONS);
  const result = resolveScopeOverride(candidates, { workspaceName: "codereview-workspace" });
  assert.deepEqual(result, {
    provided: true,
    ok: true,
    scope: { sessionId: "session-2", workspaceName: "codereview-workspace" },
  });
});

void test("resolveScopeOverride refuses when it matches zero open sessions", () => {
  const candidates = scopeCandidatesFromSessions(L2005_SESSIONS);
  const result = resolveScopeOverride(candidates, { workspaceName: "nonexistent-workspace" });
  assert.equal(result.provided, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /matched 0 of 2/);
});

void test("resolveScopeOverride refuses an override naming neither sessionId nor workspaceName", () => {
  const candidates = scopeCandidatesFromSessions(L2005_SESSIONS);
  const result = resolveScopeOverride(candidates, {});
  assert.equal(result.provided, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /carried neither/);
});

void test("resolveScopeOverride refuses when sessionId and workspaceName point at different sessions", () => {
  const candidates = scopeCandidatesFromSessions(L2005_SESSIONS);
  const result = resolveScopeOverride(candidates, {
    sessionId: "session-1",
    workspaceName: "codereview-workspace",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /matched 0 of 2/);
});

void test("selectInstanceOwningScopes returns [] when the target has no applicationId", () => {
  const candidates = scopeCandidatesFromSessions(L2005_SESSIONS);
  const result = selectInstanceOwningScopes(candidates, L2005_INSTANCES_BY_SCOPE, {
    identity: L2005_TARGET.identity,
  });
  assert.deepEqual(result, []);
});

void test("selectInstanceOwningScopes finds the single session whose snapshot owns the target instance", () => {
  const candidates = scopeCandidatesFromSessions(L2005_SESSIONS);
  const result = selectInstanceOwningScopes(candidates, L2005_INSTANCES_BY_SCOPE, L2005_TARGET);
  assert.deepEqual(result, [{ sessionId: "session-2", workspaceName: "codereview-workspace" }]);
});

// The four honest-green scenarios (L2-005 TESTS section): correct auto-selection single-candidate,
// override-pinned selection, unresolvable-override refusal, multi-candidate-no-override refusal.

void test("selectScopeForIdentify auto-selects the single session that actually owns the open instance, not the active/first one", () => {
  const result = selectScopeForIdentify({
    sessionsListResponse: L2005_SESSIONS,
    instancesByScope: L2005_INSTANCES_BY_SCOPE,
    target: L2005_TARGET,
  });
  assert.deepEqual(result, {
    ok: true,
    scope: { sessionId: "session-2", workspaceName: "codereview-workspace" },
    matchedVia: "single-instance-candidate",
  });
});

void test("selectScopeForIdentify honors an operator-pinned override, bypassing instance search", () => {
  const result = selectScopeForIdentify({
    sessionsListResponse: L2005_SESSIONS,
    override: { workspaceName: "codereview-workspace" },
    // Deliberately empty/wrong instance data: an override is trusted directly, never cross-checked
    // against instance search.
    instancesByScope: {},
    target: L2005_TARGET,
  });
  assert.deepEqual(result, {
    ok: true,
    scope: { sessionId: "session-2", workspaceName: "codereview-workspace" },
    matchedVia: "override",
  });
});

void test("selectScopeForIdentify refuses (never falls back) when the override is unresolvable", () => {
  const result = selectScopeForIdentify({
    sessionsListResponse: L2005_SESSIONS,
    override: { workspaceName: "nonexistent-workspace" },
    instancesByScope: L2005_INSTANCES_BY_SCOPE,
    target: L2005_TARGET,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "scope-override-unresolvable");
  // L2-005 residual: the candidate pool now also includes the persistent user scope (target carries an
  // applicationId), so "2" open sessions became "3" total candidates to match against.
  assert.match(result.reason, /matched 0 of 3/);
  assert.deepEqual(
    result.candidates.map((c) => c.sessionId ?? c.applicationScope),
    ["session-1", "session-2", "user"],
  );
});

void test("selectScopeForIdentify refuses with the candidate list when multiple open sessions own the instance and no override was given", () => {
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
    "session-2::codereview-workspace": [L2005_MATCHING_INSTANCE],
    "session-3::another-workspace": [L2005_MATCHING_INSTANCE],
  };
  const result = selectScopeForIdentify({
    sessionsListResponse: multiCandidateSessions,
    instancesByScope: multiCandidateInstances,
    target: L2005_TARGET,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "multi-candidate-no-override");
  assert.deepEqual(
    result.candidates.map((c) => c.sessionId),
    ["session-2", "session-3"],
  );
  // L2-005 residual: wording generalized from "session/workspace scopes" to "scopes" since a persistent
  // (non-session) candidate can now also appear in this refusal's candidate list.
  assert.match(result.reason, /2 different scopes/);
});

void test("selectScopeForIdentify falls back to the legacy heuristic when no target applicationId is given", () => {
  const result = selectScopeForIdentify({
    sessionsListResponse: L2005_SESSIONS,
    target: { identity: L2005_TARGET.identity },
  });
  assert.deepEqual(result, {
    ok: true,
    scope: { sessionId: "session-1", workspaceName: "marshal-host" },
    matchedVia: "no-application-target",
  });
});

void test("selectScopeForIdentify falls back to the legacy heuristic when no open session owns the instance", () => {
  const result = selectScopeForIdentify({
    sessionsListResponse: L2005_SESSIONS,
    instancesByScope: { "session-1::marshal-host": [], "session-2::codereview-workspace": [] },
    target: L2005_TARGET,
  });
  assert.deepEqual(result, {
    ok: true,
    scope: { sessionId: "session-1", workspaceName: "marshal-host" },
    matchedVia: "no-instance-match-fallback",
  });
});

void test("selectScopeForIdentify returns a null scope when no session is open at all (legacy behavior preserved)", () => {
  const result = selectScopeForIdentify({
    sessionsListResponse: { success: true, sessions: [] },
    target: L2005_TARGET,
  });
  assert.deepEqual(result, { ok: true, scope: null, matchedVia: "no-open-sessions" });
});

// L2-005 RESIDUAL (branch (ii), review-facility-tip): a nav-opened pane instance registers under the
// PERSISTENT USER SCOPE {applicationScope:"user", workspaceName:"marshal"} — owned by NO session — so
// every per-session-only enumeration above reports matchedInstance:null even with the pane open
// (verification/identify-l2005-live-scopefix-residual.json). Fixture: an ordinary open session
// (session-1) that does NOT own the instance; the instance is reachable only via the persistent scope.
const RESIDUAL_SESSIONS = {
  success: true,
  sessions: [{ id: "session-1", workspaceName: "marshal-host", isActive: true }],
};
const RESIDUAL_INSTANCE = {
  instanceId: "instance-nav-1",
  surface: "tab",
  owner: { extensionId: L2005_TARGET.identity, applicationId: L2005_TARGET.applicationId },
};
const RESIDUAL_INSTANCES_USER_ONLY = {
  "session-1::marshal-host": [],
  "user::marshal": [RESIDUAL_INSTANCE],
};

void test("selectScopeForIdentify finds a nav-opened instance owned only by the persistent user scope (L2-005 residual, branch (ii))", () => {
  const result = selectScopeForIdentify({
    sessionsListResponse: RESIDUAL_SESSIONS,
    instancesByScope: RESIDUAL_INSTANCES_USER_ONLY,
    target: L2005_TARGET,
  });
  assert.deepEqual(result, {
    ok: true,
    scope: { applicationScope: "user", workspaceName: "marshal" },
    matchedVia: "single-instance-candidate",
  });
});

void test("selectScopeForIdentify still finds a session-owned instance with no regression (residual fix does not disturb the L2-005 fix)", () => {
  const result = selectScopeForIdentify({
    sessionsListResponse: L2005_SESSIONS,
    instancesByScope: L2005_INSTANCES_BY_SCOPE,
    target: L2005_TARGET,
  });
  assert.deepEqual(result, {
    ok: true,
    scope: { sessionId: "session-2", workspaceName: "codereview-workspace" },
    matchedVia: "single-instance-candidate",
  });
});

void test("selectScopeForIdentify refuses listing both candidates when a session AND the persistent user scope both own the instance", () => {
  const mixedInstances = {
    "session-1::marshal-host": [RESIDUAL_INSTANCE],
    "user::marshal": [RESIDUAL_INSTANCE],
  };
  const result = selectScopeForIdentify({
    sessionsListResponse: RESIDUAL_SESSIONS,
    instancesByScope: mixedInstances,
    target: L2005_TARGET,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "multi-candidate-no-override");
  assert.deepEqual(result.candidates, [
    { sessionId: "session-1", workspaceName: "marshal-host" },
    { applicationScope: "user", workspaceName: "marshal" },
  ]);
  assert.match(result.reason, /2 different scopes/);
});

void test("selectScopeForIdentify honors an operator override pinning the persistent user scope", () => {
  const result = selectScopeForIdentify({
    sessionsListResponse: RESIDUAL_SESSIONS,
    override: { applicationScope: "user", workspaceName: "marshal" },
    // Deliberately empty: an override is trusted directly, never cross-checked against instance search.
    instancesByScope: {},
    target: L2005_TARGET,
  });
  assert.deepEqual(result, {
    ok: true,
    scope: { applicationScope: "user", workspaceName: "marshal" },
    matchedVia: "override",
  });
});

void test("selectScopeForIdentify refuses an unresolvable persistent-scope override", () => {
  const result = selectScopeForIdentify({
    sessionsListResponse: RESIDUAL_SESSIONS,
    override: { applicationScope: "user", workspaceName: "nonexistent-workspace" },
    instancesByScope: RESIDUAL_INSTANCES_USER_ONLY,
    target: L2005_TARGET,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "scope-override-unresolvable");
  assert.match(result.reason, /matched 0 of 2/);
});

void test("selectScopeForIdentify refuses an override naming an applicationScope ambiguously overlapping a session's workspaceName", () => {
  // Fixture: a session literally named workspace "marshal" would collide with the persistent user
  // scope's fixed workspaceName if applicationScope were not part of the match — proves it is.
  const collidingSessions = {
    success: true,
    sessions: [{ id: "session-x", workspaceName: "marshal", isActive: true }],
  };
  const result = selectScopeForIdentify({
    sessionsListResponse: collidingSessions,
    override: { applicationScope: "user", workspaceName: "marshal" },
    instancesByScope: {},
    target: L2005_TARGET,
  });
  assert.deepEqual(result, {
    ok: true,
    scope: { applicationScope: "user", workspaceName: "marshal" },
    matchedVia: "override",
  });
});

void test("resolveScopeOverride resolves an applicationScope-qualified override against mixed session/persistent candidates", () => {
  const candidates = [
    ...scopeCandidatesFromSessions(RESIDUAL_SESSIONS),
    { applicationScope: "user", workspaceName: "marshal" },
  ];
  const result = resolveScopeOverride(candidates, { applicationScope: "user" });
  assert.deepEqual(result, {
    provided: true,
    ok: true,
    scope: { applicationScope: "user", workspaceName: "marshal" },
  });
});
