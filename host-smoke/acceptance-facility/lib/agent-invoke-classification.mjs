// Class-killer facility step (facfix, root/facility-agent-step) — added after three
// live-only integration defects that a generic pass/fail hid: F-DEPLOY-1 (an installed
// extension manifest live-install defect), F-DEPLOY-3 (agent-originated enable/update
// mutations never reached the open renderer without a reload), and F-DEPLOY-4 (the
// agent-path `runtimeInvoke` self-tool denied a permission the live catalog itself
// declared, because the declared-permission resolver's search context silently threw
// and was swallowed by a fail-closed catch). All three shared
// one root cause pattern: the agent path failed, and every layer reported it the SAME
// generic way a legitimate deny would look. This module classifies the outer envelope a
// real agent-path capability invoke returns into exactly one of five DISTINCT shapes, so
// that class of defect can never again hide inside an undifferentiated failure again.
//
// The envelope shape classified here is `MarshalRuntimeApiResult`
// (electron/marshal-runtime/api.ts's `ProductionMarshalRuntimeApi.invoke()`) — the exact
// JSON the `runtimeInvoke` self-tool (electron/marshal-runtime/runtime-self-tools.ts)
// returns to the calling agent, live. This module only classifies that envelope; it does
// not construct one, call the runtime, or reach into any product code — see
// scripts/agent-path-invoke.mjs for how (and from where) a real envelope is obtained.
export const AGENT_INVOKE_OUTCOMES = Object.freeze([
  "policy-allow",
  "policy-ask",
  "policy-deny",
  "unsupported-deny",
  "provider-error",
]);

// The exact phrase authorize()'s fall-through deny uses (production-adapter.ts):
// `Marshal Runtime permission is not supported: ${permission}.` — this is the F-DEPLOY-4
// failure shape: the resolver chain never reached a real policy decision at all.
const UNSUPPORTED_DENY_PATTERN = /is not supported/i;

/**
 * Classifies one `MarshalRuntimeApiResult`-shaped envelope into exactly one of
 * `AGENT_INVOKE_OUTCOMES`. The envelope is untrusted input (operator-supplied JSON —
 * see scripts/agent-path-invoke.mjs), never assumed to already match the real product
 * type, so every field is checked at runtime rather than trusted from a JSDoc shape.
 * Throws on a malformed envelope rather than guessing — the same no-guess discipline
 * the live-connection guards use for endpoint/page matching.
 *
 * @param {unknown} envelope untrusted, real shape is
 *   `{ok: boolean, value?: unknown, error?: {code: string, message: string, approval?: unknown}}`
 * @returns {{outcome: (typeof AGENT_INVOKE_OUTCOMES)[number], detail: string}}
 */
export function classifyAgentInvokeOutcome(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new TypeError("classifyAgentInvokeOutcome requires an invoke-result envelope object.");
  }
  if (!("ok" in envelope) || typeof envelope.ok !== "boolean") {
    throw new TypeError("classifyAgentInvokeOutcome requires envelope.ok to be true or false.");
  }
  if (envelope.ok) {
    return {
      outcome: "policy-allow",
      detail: "invoke() returned ok:true — the capability executed under an allow decision.",
    };
  }
  const error = "error" in envelope ? envelope.error : undefined;
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    typeof error.code !== "string" ||
    !error.code
  ) {
    throw new TypeError(
      "classifyAgentInvokeOutcome requires envelope.error.code when ok is false.",
    );
  }
  const code = error.code;
  const rawMessage = "message" in error ? error.message : undefined;
  const message = typeof rawMessage === "string" ? rawMessage : "";
  if (code === "approval-required") {
    return {
      outcome: "policy-ask",
      detail: `invoke() returned error.code:"approval-required" — a policy prompt was surfaced: ${message}`,
    };
  }
  if (code === "permission-denied") {
    if (UNSUPPORTED_DENY_PATTERN.test(message)) {
      return {
        outcome: "unsupported-deny",
        detail: `invoke() denied with the F-DEPLOY-4 "not supported" shape — the resolver chain never reached policy: ${message}`,
      };
    }
    return {
      outcome: "policy-deny",
      detail: `invoke() returned a real policy deny (resolver/authorize was reached): ${message}`,
    };
  }
  // Any other code ("operation-failed", "not-found", "invalid-request",
  // "runtime-unavailable", "aborted", ...) means the decision layer either allowed the
  // call through to execution or was never the blocker — the failure is the provider's,
  // the kernel dispatch's, or the request's own shape, not a permission verdict.
  return {
    outcome: "provider-error",
    detail: `invoke() failed past the permission decision with code ${JSON.stringify(code)}: ${message}`,
  };
}

/**
 * One real-shaped fixture envelope per outcome, built from the exact code/message shapes
 * `electron/marshal-runtime/api.ts` and `production-adapter.ts` produce (see file-level
 * comment) — not invented strings. Used by both the deterministic kernel-mock test in
 * scripts/agent-path-invoke.mjs and lib/agent-invoke-classification.test.mjs.
 */
export const AGENT_INVOKE_ENVELOPE_FIXTURES = Object.freeze({
  "policy-allow": Object.freeze({
    ok: true,
    value: { output: { items: ["row 1 (page 1)"], page: 1, hasMore: true } },
    receipts: [],
  }),
  "policy-ask": Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "approval-required",
      message: "Local repository intelligence requires explicit user approval.",
      approval: Object.freeze({
        approvalId: "runtime-perm-fixture",
        prompt: "Create a local intelligence index for /repo?",
      }),
    }),
    receipts: [],
  }),
  "policy-deny": Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "permission-denied",
      message: "Marshal Runtime approval was rejected (denied).",
    }),
    receipts: [],
  }),
  "unsupported-deny": Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "permission-denied",
      message: "Marshal Runtime permission is not supported: codereview.read.",
    }),
    receipts: [],
  }),
  "provider-error": Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "operation-failed",
      message: "Deliberate acceptance-facility provider failure.",
    }),
    receipts: [],
  }),
});
