# D4 — installed-acceptance facility

Reusable facility for exercising an **installed** Marshal Runtime extension the way an actual user or
agent session would, closing the gap AUDIT-VERDICT-AND-ACCEPTANCE.md names under "Testing capability
gaps": _"Fable had source/build/testing tools and real Chromium... He did not have a demonstrated,
routinely usable way to drive and inspect the installed Marshal iframe."_ This directory is that way —
runnable by both the extension agent and Codex, against a sample app checked in here, with worked
examples for what's runnable without the live app and honest `blocked` receipts for what isn't.

No part of this facility restarts, rebuilds, or launches Marshal itself. Everything defaults to
read-only/offline; the few things that _can_ reach a live, already-running instance require an explicit
opt-in environment variable (see "Live mode" below) that the parent sets when it owns that step.

## Quick start

```bash
node host-smoke/acceptance-facility/scripts/run-all.mjs
```

Runs every runnable-without-a-live-app step, writes one receipt per step into `example-receipts/`, and
writes `example-receipts/facility-summary.json` — a rollup by evidence class. Safe to run repeatedly;
every run overwrites the previous receipts (nothing here mutates shared/global state).

## The six audit points → what's here

| #   | Audit requirement                                                                                                  | File(s)                                                                                                                              | Evidence class(es)                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) | Installed artifact identification (identity/integrity/publication/declared actions/runtime errors/actual viewport) | `scripts/identify-installed-artifact.mjs`, `lib/live-scope-discovery.mjs`, `lib/identity-verification.mjs`, `lib/frame-geometry.mjs` | `kernel-mock` (always runs), `installed-api` (live-gated)                                                                                                                         |
| (b) | Real application execution under NORMAL policy, no allow-all broker                                                | `scripts/execute-application-route.mjs`, `lib/declared-permission-broker.mjs`, `lib/capability-invoke-verification.mjs`              | `kernel-mock` (always runs), `installed-api` (live-gated)                                                                                                                         |
| (c) | Visual/user operation: real capture/click/type/scroll/resize/native selection                                      | `scripts/drive-native-frame.mjs`                                                                                                     | `installed-ui` (always live-gated)                                                                                                                                                |
| (d) | Deterministic native-frame regression suite, distinct from provider acceptance                                     | `scripts/run-native-frame-regression.mjs`, `native-frame/controlled-scenarios.browser.test.tsx`                                      | `native-frame`                                                                                                                                                                    |
| (e) | Provider acceptance receipt helpers (account/scope, known-PR diff, authorized write)                               | `scripts/provider-acceptance-receipts.mjs`, `lib/provider-comparisons.mjs`, `lib/provider-acceptance-mode.mjs`                       | `unit` (helper logic), `provider-read`/`external-write` (blocked by default; live and pass/fail-verified when `ACCEPTANCE_FACILITY_ALLOW_LIVE=1` plus operator-supplied evidence) |
| (f) | Explicit evidence classes, blocked never silently downgraded                                                       | `lib/evidence-classes.mjs`, `lib/receipt.mjs`                                                                                        | all seven                                                                                                                                                                         |

## Evidence classes (exact ids)

```
unit | kernel-mock | native-frame | installed-api | installed-ui | provider-read | external-write
```

`lib/evidence-classes.mjs` is the single source of truth for these seven ids; `lib/receipt.mjs`'s
`writeReceipt()`/`buildReceipt()` rejects anything else. A class this facility cannot exercise from a
given run is written as `status: "blocked"` with a `reason` — never silently reported under a weaker or
stronger class, and never turned into a fake pass.

Every receipt has this shape (see `lib/receipt.mjs`):

```jsonc
{
  "schemaVersion": 1,
  "evidenceClass": "installed-api",
  "status": "pass" | "fail" | "blocked",
  "facility": "identify-installed-artifact",
  "subject": "what was exercised",
  "generatedAt": "ISO timestamp",
  "revision": { "identity": "...", "version": "...", "integrity": "sha256-..." } | null,
  "reason": "required when status is fail/blocked",
  "limits": ["honest statements of what this receipt does NOT prove"],
  "secretsRedacted": true,
  "proof": { /* redacted evidence payload */ }
}
```

`proof` is always passed through `lib/redact.mjs`'s `redactSecrets()` before being written — object keys
that look secret-shaped (`token`, `password`, `authorization`, `cookie`, ...) are replaced wholesale, and
every string leaf is scanned for emails, `Bearer <token>`, and GitHub PAT shapes. No screenshot, receipt,
or log this facility writes contains a raw email, token, or session content.

## Entry points

Run any of these directly, or all of them via `scripts/run-all.mjs`.

- **`scripts/run-unit-tests.mjs`** — runs `node --test` over `lib/*.test.mjs` (receipt/redaction/
  provider-comparison helper logic). Evidence class `unit`.
- **`scripts/identify-installed-artifact.mjs`** — (a). Always produces a `kernel-mock` receipt by
  registering the sample app (`sample-app/`) in a real `@marshal/runtime` `RuntimeKernel` and reporting
  its identity/version/integrity/declared actions/declared capabilities. Also attempts an `installed-api`
  receipt against a live Marshal (see "Live mode"): discovers a REAL `{sessionId, workspaceName}` scope
  from `window.sessionsAPI.list()` (never calls the extensions/UI APIs with an empty scope), requires an
  explicit `ACCEPTANCE_FACILITY_LIVE_TARGET` naming the installed extension/application to identify,
  checks every IPC envelope's `success` flag, requires the matched candidate's status to be exactly
  `"installed-enabled"` (never a merely-`"detected"` or disabled candidate), and independently
  recomputes its integrity from disk against an operator-pinned `expectedIntegrity` — an
  `"installed-enabled"` status alone is never treated as integrity proof — see
  `lib/identity-verification.mjs`. Can only report `pass` once both the identity and integrity gates are
  met. When the target has an open instance, also measures its REAL iframe geometry via
  `getBoundingClientRect()` (`lib/frame-geometry.mjs`), verifies its CURRENT publication via a live
  `runtime-ui:readResource`, and verifies its declared actions against `expectedDeclaredActions` —
  N-FF1 + L2R-001: read from the PUBLICATION application record via a post-guard
  `runtime-ui:getPlacements` (the publication manifest's `actions[].id` / `tools[].name`), never from
  the matched instance's `content.descriptor` (an open-time snapshot frozen at `controller.open`, never
  refreshed on extension update) — `proof.gates` in the receipt names exactly which of these were
  verified vs unmet, instead of just the whole browser window's `innerWidth`/`innerHeight`.
- **`scripts/execute-application-route.mjs`** — (b). `kernel-mock`: invokes the sample app's one
  capability under a **declared-only** permission broker (`lib/declared-permission-broker.mjs` —
  deliberately NOT `createAllowAllPermissionBroker()` from `@marshal/agent-runtime-core`, the exact
  pattern the audit criticized) and proves declared-permission → allow, undeclared-permission → deny.
  Also attempts an `installed-api` receipt against a live Marshal driving the real
  `window.runtimeUiAPI.invokeCapability` route; when the operator's request omits `publicationRevisionId`
  it fetches the CURRENT one itself via `runtime-ui:getSnapshot` + `runtime-ui:readResource` first (see
  `lib/capability-invoke-verification.mjs`) — packaged HTML applications gated by a live publication
  otherwise deny the invoke with "This application bundle is stale."
- **`scripts/drive-native-frame.mjs <capture|click|type|scroll|select|resize> [title] [role] [name] [value]`**
  — (c). Always `installed-ui`, always live-gated (there is no non-live "installed" surface). Uses
  Playwright's `frameLocator` over a CDP connection (`lib/live-connection.mjs`'s
  `connectPageOverCDP()`), NOT raw `document.querySelector` JS evaluation — the packaged application
  iframe is `sandbox="allow-scripts"` with no `allow-same-origin`, so it has an opaque origin a same-realm
  JS call cannot reach, the same restriction the app's own script has. `frameLocator` dispatches through
  the browser's automation layer instead, which is what actually reaches a real user's click.
- **`scripts/run-native-frame-regression.mjs`** — (d). Runs two things, both evidence class
  `native-frame`:
  1. D1's shared-contract regression file, **by path, never edited or duplicated here**:
     `src/features/runtime-ui/RuntimeUiApplicationWorkspace.layout.browser.test.tsx`, via
     `pnpm exec vitest run --project browser <path>`. If the file isn't present in this worktree (D1
     lands it in its own swarm lane), this is recorded `blocked`, not skipped silently.
  2. This facility's own controlled-data scenarios:
     `native-frame/controlled-scenarios.browser.test.tsx`, via its own isolated
     `native-frame/vitest.config.ts` (kept out of the repo's shared `vitest.config.ts` on purpose — this
     facility owns `host-smoke/acceptance-facility/**` only).
- **`scripts/provider-acceptance-receipts.mjs`** — (e). By default (no live opt-in) runs
  `lib/provider-comparisons.mjs`'s three helpers against local example fixtures
  (`sample-app/provider-fixtures.mjs`) and writes `blocked` `provider-read`/`external-write` receipts (no
  network, no real provider call, in this default mode). With `ACCEPTANCE_FACILITY_ALLOW_LIVE=1` **and**
  the matching evidence env var set (see "Live mode"), it instead runs those same helpers against
  operator-supplied, independently-obtained evidence and writes `pass`/`fail` from the real comparison —
  this script itself still never makes a network call; the operator obtains the evidence and passes it in
  as JSON. `ACCEPTANCE_FACILITY_ALLOW_LIVE=1` with no evidence env var still writes `blocked`, never a
  fabricated pass (`lib/provider-acceptance-mode.mjs`). The helper _logic_ itself is separately
  unit-tested (`lib/provider-comparisons.test.mjs`, evidence class `unit`) so its correctness doesn't
  depend on having live access.
- **`scripts/agent-path-invoke.mjs`** — class-killer step (see "Class-killer: agent-path invoke" below).
  Always produces a `kernel-mock` receipt classifying five fixture-shaped envelopes into the five agent-
  path invoke outcomes (`lib/agent-invoke-classification.mjs`). Also attempts an `installed-api` receipt
  from operator-supplied evidence of one real agent-path invoke (see "Live mode" — this step has no CDP
  route, unlike the others). The `installed-api` receipt's `pass`/`fail`/`blocked` verdict is decided by
  `lib/agent-invoke-gate.mjs`'s `evaluateAgentInvokeGate()` — see "Class-killer: agent-path invoke" for
  why a classification alone is never enough.
- **`scripts/capture-fdeploy-agentgate-receipts.mjs`** — honest-red/green capture for the agent-path
  invoke acceptance gate (`test-receipts/fdeploy-agentgate-red.txt` / `fdeploy-agentgate-green.txt`).
- **`scripts/run-all.mjs`** — runs everything above in order and writes
  `example-receipts/facility-summary.json`.

## The sample app

`sample-app/` is a minimal packaged HTML application (`index.html`, `manifest.mjs`,
`capability-provider.mjs`, `provider-fixtures.mjs`) checked in here — not installed into the live
extension library, not touching real GitHub data. It's tall enough (1700px) to exercise
geometry, and every interactive control (refresh button, query input, item select, paginated list,
error-trigger button, scroll sentinel, a deliberately-overflowing long line) reports its own DOM state
back to the host over the same `tools/call` JSON-RPC bridge production packaged apps use — so
`native-frame/controlled-scenarios.browser.test.tsx` can drive it with real external browser automation
and then get an **independent** confirmation, from the sandboxed content's own perspective, that the
click/type/scroll/select actually landed. That's the exact gap the audit named: _"An API success alone
cannot certify that a button works."_

`capability-provider.mjs` declares exactly one capability, `acceptance-sample.read`, with exactly one
declared permission of the same name — this is what `lib/declared-permission-broker.mjs` and the
kernel-mock scripts exercise the declare/grant/deny-by-default shape against.

## Live mode

Every script defaults to `status: "blocked"` for anything that needs a real, already-running,
already-authenticated Marshal. To exercise those:

```bash
ACCEPTANCE_FACILITY_ALLOW_LIVE=1 ACCEPTANCE_FACILITY_CDP_PORT=9333 \
  node host-smoke/acceptance-facility/scripts/identify-installed-artifact.mjs
```

- `ACCEPTANCE_FACILITY_ALLOW_LIVE=1` — required opt-in. Without it, live-gated scripts never attempt a
  connection.
- `ACCEPTANCE_FACILITY_CDP_PORT` — **required, no default** (F-DEPLOY-2 repair; see "Live-connection
  guards" below). There is no fallback port — set it to whatever debug port the operator actually opened
  (e.g. `pnpm electron:debug`'s documented port). Omitting it is a typed refusal
  (`missing-explicit-cdp-port`) before any connection is attempted, not a silent default.
- `ACCEPTANCE_FACILITY_LIVE_TARGET` — required by `identify-installed-artifact.mjs`'s live path: a JSON
  object `{identity, applicationId, expectedIntegrity, expectedDeclaredActions, expectedDeclaredTools, scopeOverride}` naming the
  real installed extension identity (and, optionally, the application to correlate an open instance/iframe
  geometry against) to identify. This facility never guesses which installed extension to identify; it
  discovers the session/workspace scope itself from `window.sessionsAPI.list()`. `expectedIntegrity` — the
  installed revision's independently-known sha256 package digest — is **required** for a `pass`:
  `lib/identity-verification.mjs` independently recomputes the real digest from the matched item's
  `packageRoot` (`computeRuntimeExtensionIntegrity`, the same function the runtime itself enforces on
  install/load) and only reports the integrity gate `met` when it matches; an `"installed-enabled"`
  status alone is never treated as integrity proof. `expectedDeclaredActions` (optional, array of action
  ids) additionally verifies the target application's declared actions when supplied; omitting
  it still reads the declared actions but reports that gate `unmet`, never silently `met`. N-FF1 +
  L2R-001: the declared-actions evidence source is the PUBLICATION application record — a post-guard
  `window.runtimeUiAPI.getPlacements(scope)` read, checked against the publication manifest's
  `actions[].id` (and the optional `expectedDeclaredTools` against its `tools[].name`) — never the
  matched instance's `content.descriptor`, which is an open-time snapshot frozen at `controller.open`
  and never refreshed on extension update (the instance match only anchors WHICH
  extension/application/owner is checked). See `proof.gates` in the receipt for exactly which of
  identity/integrity/publication/declaredActions were verified vs unmet this run.
  - **Scope discovery (L2-005 + residual, branch (ii)).** `runtime-ui:getSnapshot(scope)` filters open
    application instances by the exact scope queried — the target's open pane is invisible to any scope
    that isn't the one it actually lives under. When `applicationId` is set, this facility checks EVERY
    open session's own snapshot PLUS the persistent user scope
    (`{applicationScope: "user", workspaceName: "marshal"}` — the scope a NAV-OPENED pane instance
    registers under, e.g. clicking "Pull Requests" in the primary nav rather than opening it from a chat
    session; per-session snapshots structurally can never see it) for the target instance
    (`lib/live-scope-discovery.mjs`'s `selectScopeForIdentify`) instead of assuming the active/first
    session's workspace owns it: exactly one candidate (session or persistent) owning it is auto-selected;
    zero falls back to the active/first-session heuristic (the identity/integrity gates can still run;
    publication/declaredActions/viewport stay `unmet`); **more than one is a typed refusal** listing every
    candidate — this facility never guesses which open instance the operator meant. `scopeOverride`
    (optional `{sessionId?, workspaceName?, applicationScope?}`) lets an operator who already knows which
    open session/workspace — or persistent scope — owns the target pin it directly, bypassing candidate
    search entirely; a supplied override that doesn't resolve to exactly one currently-open
    session/persistent scope is also a typed refusal, never a silent fallback to auto-discovery.
    `runtimeExtensionsAPI.status` (the identity/integrity gate) always uses a real session scope — it can
    never accept the persistent scope — while `getSnapshot`/`readResource`/geometry use whichever scope
    actually owns the instance. Persistent _workspace_-scoped candidates
    (`applicationScope: "workspace"`) are a real, structurally identical concept but are not enumerated —
    no known defect reaches through one.
- `ACCEPTANCE_FACILITY_LIVE_INVOKE` — required by `execute-application-route.mjs`'s live path: a JSON
  object `{applicationScope, workspaceName, extensionId, applicationId, instanceId, capability, input,
idempotencyKey, publicationRevisionId}` naming the real installed application instance and capability to
  invoke. `publicationRevisionId` is optional in the request — when omitted, the script fetches the
  CURRENT one itself via `runtime-ui:getSnapshot` + `runtime-ui:readResource` before invoking. This
  facility never invents the rest of the request.
- `ACCEPTANCE_FACILITY_LIVE_ACCOUNT_SCOPE` / `ACCEPTANCE_FACILITY_LIVE_KNOWN_PR` /
  `ACCEPTANCE_FACILITY_LIVE_WRITE` — consumed by `provider-acceptance-receipts.mjs`'s live path: JSON
  objects the operator independently obtains (`{accountsList, expected}`,
  `{localPrDetail, providerPrDetail, expected}`, `{before, after, expectation}` respectively — see
  `lib/provider-comparisons.mjs` for each helper's exact shape). This facility never fetches provider
  evidence itself (no network in this lane, live or not); omitting the matching env var while
  `ACCEPTANCE_FACILITY_ALLOW_LIVE=1` is set still produces a `blocked` receipt for that step, not a pass.
  `compareKnownPr`'s `localPrDetail`/`providerPrDetail` require a top-level `headSha` plus, for every
  `files`/`threads`/`checks` entry, the required fields `{path, patch}` / `{id, body}` / `{name,
conclusion}` respectively (`iterations` entries require `id`) — comparisons are by normalized content
  keyed on identity (file path, thread id, check name), not array length, and any entry missing a
  required field forces that field to reject regardless of count agreement.

- `ACCEPTANCE_FACILITY_LIVE_AGENT_INVOKE` — consumed by `agent-path-invoke.mjs`'s live path: a JSON
  object `{capability, envelope}` where `envelope` is the exact `MarshalRuntimeApiResult` JSON a real,
  authorized agent-path `runtimeInvoke` call returned for `capability` under NORMAL policy. Unlike the
  other live steps, this facility never invokes the agent path itself — see "Class-killer: agent-path
  invoke" below for why — so the operator (or an authorized live agent lane) independently invokes a
  real capability and supplies the resulting envelope; this facility only classifies it.
  `ACCEPTANCE_FACILITY_CDP_PORT` is not used by this step. **`envelope.receipts[0]` must carry
  `receiptId`/`executionId`/`target`/`scope`/`startedAt`/`completedAt`, with `target` naming the
  declared `capability`** — a classifiable envelope with no bound runtime-receipt is `blocked`, never a
  `pass` (see "Class-killer: agent-path invoke").
- `ACCEPTANCE_FACILITY_LIVE_AGENT_INVOKE_EXPECT` — the operator's declared expected outcome for the
  invoke above: one of `policy-allow`, `policy-ask`, `policy-deny`. The gate passes only when the
  classified outcome exactly matches; `unsupported-deny` and `provider-error` always fail regardless of
  what was declared (they are executed-and-defective shapes, never a legitimate expectation).

`lib/live-connection.mjs` has two connectors:

- `connectToRunningMarshal(port)` — plain `chrome-remote-interface` (same package and target-selection
  heuristic as `e2e-real/marshal-cdp-helpers.mjs`'s `connectToApp()`), for calling
  `window.runtimeExtensionsAPI`/`window.runtimeUiAPI` methods directly in the top-level renderer's own
  JS realm. Used by `identify-installed-artifact.mjs` and `execute-application-route.mjs`.
- `connectPageOverCDP(port)` — Playwright's `chromium.connectOverCDP()`, giving a real `Page` with
  `frameLocator()` support. Used by `drive-native-frame.mjs`, the only script that must reach _inside_
  the sandboxed application iframe.

This facility never restarts, rebuilds, or launches Marshal — it only connects to a debug port an
operator already opened. Running any live-gated script without an already-running debug-mode Marshal
will simply fail to connect (or, without the opt-in, records the honest `blocked` receipt above).

### Live-connection guards (F-DEPLOY-2)

A live run of `identify-installed-artifact.mjs` without `ACCEPTANCE_FACILITY_CDP_PORT` set previously
fell back to a hardcoded default port (9222) — which, live, was the operator's personal Google Chrome
rather than Marshal, and the script attached to it and evaluated its (static, read-only) discovery
expression inside whatever tab happened to be open. Nothing was exfiltrated, but the facility must never
be _able_ to do this regardless of operator error. Both connectors in `lib/live-connection.mjs` now apply
three guards, in this order, before any of a caller's own work runs:

1. **Explicit port required.** `liveModePort()` has no default; a missing or non-numeric
   `ACCEPTANCE_FACILITY_CDP_PORT` is a typed refusal (`LiveConnectionRefusalError` with
   `code: "missing-explicit-cdp-port"`) raised before any connection is attempted.
2. **Endpoint verification.** Before any `Runtime.evaluate`, the connector fetches `/json/version` and
   checks it via `isKnownNonMarshalBrowserString(Browser, User-Agent)`: a known real-desktop-browser
   `Browser` product string (`Chrome/`, `Firefox/`, `Safari/`, `Edg/`, `OPR/`) is rejected **only when**
   `User-Agent` also carries neither a `Marshal/` nor an `Electron/` marker. This is metadata acceptance
   via `User-Agent`, never `Browser`-string guessing — Electron's own CDP handshake reports the
   underlying Chromium build's `Browser` string (e.g. `Chrome/146.0.7680.166` for this repo's Electron
   41.1.1), the exact same shape a real desktop Chrome install reports, but Electron always appends
   `Marshal/<version> ... Electron/<version>` to `User-Agent`, which a real desktop browser never does
   (F-DEPLOY-2b, see below). Passing this check is still only ever "inconclusive, proceed" — it then runs
   exactly one evaluate, regardless of the metadata outcome — the FIRST and only evaluate before the
   connection is handed back to the caller — checking for Marshal's own `window.sessionsAPI`/
   `window.runtimeUiAPI` preload globals (`electron/preload.cjs`). Anything that doesn't expose them is
   refused (`code: "non-marshal-endpoint"`); a spoofed `Marshal/`/`Electron/` `User-Agent` on a
   non-Marshal endpoint is caught here, not by the metadata check.
3. **Confident target match only.** The renderer/page matcher accepts `marshal://app/index.html`
   (primary, the deployed packaged app) or the legacy `/dist/index.html` (secondary, dev builds) — and
   nothing else. Every prior blind first-page/`[0]` fallback is removed; no confident match is a typed
   refusal (`code: "no-marshal-page"`), never a guess.

All three guards are unit-tested in `lib/live-connection.test.mjs` (fast, no browser required — the
pure decision functions `selectMarshalPageTarget()` and `isKnownNonMarshalBrowserString()` are exported
for exactly this). `scripts/capture-facfix-receipts.mjs` additionally reproduces the pre-repair
vulnerability and the post-repair refusals against a real, test-owned, ephemeral-port headless Chromium
(this repo's own bundled `@playwright/test` dependency — never the user's browser), writing
`test-receipts/facfix-red.txt` / `facfix-green.txt`. Re-run it with:

```bash
node host-smoke/acceptance-facility/scripts/capture-facfix-receipts.mjs
```

#### F-DEPLOY-2b: metadata over-rejection (Codex-found, independently confirmed)

The guard-2 repair above originally rejected any known-desktop-browser `Browser` string outright,
including Electron's own — which reports a Chrome-shaped `Browser` string, not `Electron/<version>` as
that repair's comment falsely claimed. Live-verified: the deployed host's real `/json/version` on its
documented `9333` debug port reports `Browser="Chrome/146.0.7680.166"` (committed fixture:
`example-receipts/live-demonstration/json-version-9333.json`, captured read-only, no CDP attach). That
pattern refused the real Marshal endpoint — fail-closed held (no evaluate ran), but the facility could
never drive a live Marshal at all. The current guard-2 description above is the repaired behavior:
`User-Agent` is the metadata signal, `Browser` alone never decides anything, and the marker probe stays
mandatory regardless. `scripts/capture-facfix2-receipts.mjs` reproduces the superseded over-rejection
against the real fixture (`test-receipts/facfix2-red.txt`) and proves the repaired acceptance/refusal/
spoofed-User-Agent-still-caught behavior (`test-receipts/facfix2-green.txt`). Re-run it with:

```bash
node host-smoke/acceptance-facility/scripts/capture-facfix2-receipts.mjs
```

`scripts/capture-facfix2-live-receipt.mjs` performs one authorized, read-only, end-to-end verification
against a real, already-running Marshal — connect → metadata verify → match `marshal://app/index.html` →
the single mandatory marker probe → clean disconnect, nothing else evaluated, nothing mutated — writing
`test-receipts/facfix2-live-9333.txt`. Like the other live-gated entry points, it requires the same
explicit `ACCEPTANCE_FACILITY_ALLOW_LIVE=1`/`ACCEPTANCE_FACILITY_CDP_PORT` opt-in and is not part of
`run-all.mjs`'s offline pipeline.

### Class-killer: agent-path invoke (F-DEPLOY-1/F-DEPLOY-3/F-DEPLOY-4)

Three separate defects only ever surfaced against the deployed product, and each one hid behind an
outcome that looked like an ordinary deny or a generic failure: F-DEPLOY-1 (an installed extension
manifest live-install defect), F-DEPLOY-3 (an agent-originated enable/update mutation never reached the
open renderer without a reload), and F-DEPLOY-4 (the agent-path `runtimeInvoke` self-tool denied a
permission the live catalog itself declared, because the declared-permission resolver's search context
silently threw and was swallowed by a fail-closed catch). No prior offline suite covered "does an
ordinary agent-path capability invoke actually work end to end, and if not, exactly how did it fail" —
`scripts/agent-path-invoke.mjs` closes that gap by exercising one real agent-path capability invoke under
NORMAL policy and recording the outcome as one of exactly five distinct shapes
(`lib/agent-invoke-classification.mjs`), so this class of defect can never again hide inside an
undifferentiated failure:

- `policy-allow` — the invoke executed under an allow decision (`{ok: true}`).
- `policy-ask` — policy surfaced an approval prompt (`error.code: "approval-required"`).
- `policy-deny` — a real policy verdict denied the call (`error.code: "permission-denied"`, resolver
  reached policy).
- `unsupported-deny` — the F-DEPLOY-4 shape: `error.code: "permission-denied"` with the literal
  `"...is not supported: <permission>."` message — the resolver chain never reached a policy decision at
  all, even though the capability's own catalog descriptor declares the permission.
- `provider-error` — the decision layer was reached/passed and the failure happened elsewhere (the
  provider itself, the kernel dispatch, or the request's own shape) — any other error code.

**Route (non-CDP).** The `runtimeInvoke` self-tool (`electron/marshal-runtime/runtime-self-tools.ts`) is a
main-process-only tool the Marshal Runtime host exposes to an agent's own tool-call loop; unlike
`window.runtimeExtensionsAPI`/`window.runtimeUiAPI`/`window.sessionsAPI`, it has no renderer bridge a CDP
connector can call. This facility carries no agent/MCP broker client of its own (adding one is
electron/**-shaped work, outside `host-smoke/acceptance-facility/**`), so — exactly like
`provider-acceptance-receipts.mjs`'s live branch — it never invokes the agent path itself:
`ACCEPTANCE_FACILITY_LIVE_AGENT_INVOKE`(see "Live mode") carries an operator-independently-obtained real
invoke envelope, and this step's job is to classify it honestly, never to fabricate one. Deterministic
(non-live,`kernel-mock`) coverage instead classifies five fixture-shaped envelopes built from
`electron/marshal-runtime/api.ts`'s and `production-adapter.ts`'s real code/message shapes — see
`lib/agent-invoke-classification.test.mjs`.

**The acceptance gate: pass-by-classification is abolished (Codex-found 04:43, binding repair).** The
step's first landing (commit `7cb059c12`) wrote `installed-api` status `pass` for ANY classification the
envelope produced — including `unsupported-deny` (the exact F-DEPLOY-4 failure shape) and
`provider-error`. That made the step unable to fail on the very defect class it exists to catch: a live
regression reproducing F-DEPLOY-4 would have shown up as a passing receipt. `lib/agent-invoke-gate.mjs`'s
`evaluateAgentInvokeGate()` (called by `scripts/agent-path-invoke.mjs`; `lib/agent-invoke-classification.mjs`'s
classifier itself is unchanged — it always told these shapes apart correctly) is the real gate:

- **A pass requires a provenance-bound runtime-receipt.** `envelope.receipts[0]` must carry `receiptId`,
  `executionId`, `target`, `scope`, and an ordered `startedAt`/`completedAt` pair, and `target` must name
  the declared `capability` — proof a real invocation happened, not just a well-shaped envelope an
  operator typed by hand. Missing or malformed provenance is a typed refusal (`blocked`), never a pass —
  same no-guess discipline as the live-connection endpoint/page guards.
- **A pass requires a matching declared expectation.** `ACCEPTANCE_FACILITY_LIVE_AGENT_INVOKE_EXPECT`
  names the outcome the operator expected (`policy-allow`/`policy-ask`/`policy-deny`); the gate passes
  only when the classified outcome exactly matches it.
- **`unsupported-deny` and `provider-error` always fail**, regardless of any declared expectation — they
  are executed-and-defective shapes, never a legitimate policy outcome to expect and pass on.

Honest-red/green: `scripts/capture-fdeploy-agentgate-receipts.mjs` reproduces the pre-repair defect
(`test-receipts/fdeploy-agentgate-red.txt` — a frozen copy of `7cb059c12`'s pass-by-classification branch
passing an `unsupported-deny` envelope) and proves the repaired matrix
(`test-receipts/fdeploy-agentgate-green.txt`) by calling the exact same `evaluateAgentInvokeGate()` the
real step uses — never a re-implementation. Permanent regression coverage lives in
`lib/agent-invoke-gate.test.mjs`. Re-run it with:

```bash
node host-smoke/acceptance-facility/scripts/capture-fdeploy-agentgate-receipts.mjs
```

## Honest limits

- **`kernel-mock` is not `installed-api`.** The kernel-mock scripts prove the `@marshal/runtime`
  `RuntimeKernel` contribution/permission-broker contract; they do **not** exercise the real
  per-session `PermissionPolicy`/approval UX (`electron/permission-policy.ts`), the real installed-
  extension catalog, or any native viewport (there is no rendered frame at that layer). Every
  kernel-mock receipt's `limits` field says this explicitly.
- **`installed-api`/`installed-ui`/`provider-read`/`external-write` are `blocked` by default in this
  repo's own runs**, because this task never runs against the live deployed app or a real GitHub
  account itself (see the swarm task's hard boundaries). The scripts are real, runnable, and produce a
  genuine `pass`/`fail` — the parent (or the extension agent, once authorized) sets
  `ACCEPTANCE_FACILITY_ALLOW_LIVE=1` and supplies the documented real target/evidence env var(s) to
  actually exercise them. `provider-acceptance-receipts.mjs`'s live branch still never makes a network
  call itself — the operator independently obtains the provider evidence and passes it in as JSON; this
  facility only runs the comparison and reports the verdict honestly.
- **The provider-acceptance example fixtures are deliberately imperfect**, not a happy-path-only demo:
  `provider-known-pr` compares an empty local view against a populated provider response (the exact
  gap `AUDIT-TEST-EVIDENCE.md` found in the live product), and `provider-authorized-write` reproduces
  a changed-commit-SHA-but-unchanged-bytes mock (the exact gap
  `AUDIT-VERDICT-AND-ACCEPTANCE.md` names: _"A mock returns a commit SHA, so the test passes without
  proving changed file bytes"_). Both receipts correctly report `verified: false` inside their proof —
  that is the helper working correctly, not a facility bug.
- **D1's regression file is referenced by path only.** If it isn't present in the worktree this script
  runs from (e.g. before the swarm's lanes are integrated), `run-native-frame-regression.mjs` records
  that as `blocked`, not as a pass or a skip.
- **No network in any test.** `provider-acceptance-receipts.mjs` and the unit tests never make an HTTP
  request. The only scripts that open any external connection are the three live-gated ones, and only
  to an already-running local Marshal's own CDP debug port — never to a remote host.
- **A CDP debug port is not, by itself, proof of a Marshal renderer.** F-DEPLOY-2 (see "Live-connection
  guards" above): a live run with no explicit `ACCEPTANCE_FACILITY_CDP_PORT` used to fall back to a
  hardcoded default and could attach to whatever was actually listening there — the operator's own
  browser, in the reproduced finding. There is no default port anymore, endpoint identity is verified
  before any evaluate, and page matching never guesses; each of the three guards is a typed refusal, not
  a silent skip.
- **`Browser` alone never decides endpoint identity.** F-DEPLOY-2b (see "Live-connection guards" above):
  Electron's own CDP handshake reports the same Chrome-shaped `Browser` string a real desktop Chrome
  install reports — the metadata check reads `User-Agent` instead, and even a passing metadata check
  never substitutes for the mandatory marker-probe evaluate.
- **Scope auto-discovery costs one `runtime-ui:getSnapshot` call per open session, plus one for the
  persistent user scope.** (L2-005 + residual, branch (ii).) When the target names an `applicationId` and
  no `scopeOverride` was supplied, this facility queries every open session's own snapshot PLUS the
  persistent user scope (where a nav-opened, not session-opened, pane instance registers) to find which
  one owns the target instance — correctness over a single guessed call, at the cost of O(open sessions)
  - 1 round-trips. An operator who already knows the answer should supply `scopeOverride` to skip the
    search entirely.
- **Zero matching candidates is not a refusal.** If no session's or the persistent scope's snapshot owns
  the target instance, this facility falls back to the legacy active-else-first heuristic rather than
  refusing outright — the identity/integrity gates can still run from that scope; `publication`/
  `declaredActions`/viewport geometry simply stay `unmet`/uncaptured, exactly as when no instance is open
  at all. Only an
  _unresolvable override_ or _more than one_ owning candidate (session and/or persistent) is a typed
  refusal.
- **The declared-actions gate reads the PUBLICATION surface, never the instance descriptor.** (N-FF1 +
  L2R-001, adjudicated.) The matched instance's `content.descriptor` is an open-time snapshot of the
  publication manifest frozen at `controller.open` (persisted for user-scope instances, never refreshed
  on extension update) — arbitrarily stale — and the previous gate additionally read a
  `declaredActions` field on it that no product surface ever emits (the real `UiApplicationManifest`
  fields are `actions[]`/`tools[]`), making the gate structurally unmeetable. The repaired gate reads
  the publication application record via a post-guard `runtime-ui:getPlacements` and checks
  `actions[].id` / `tools[].name`. Honest constraint: at the current product baseline the
  `getPlacements` IPC projection (`toDesktopPlacementApplication` in `electron/ipc/runtime-ui-ipc.ts`)
  carries the record's identity/title/renderId but not its `application` manifest — when the projection
  carries no manifest, the gate reports applicable-but-unmet with that exact reason (never assumed from
  the instance snapshot, never silently `met`); the fixture-driven red/green proof
  (`test-receipts/nff1-red.txt` / `nff1-green.txt`, `scripts/capture-nff1-receipts.mjs`) exercises the
  authoritative publication-record shape end to end.
- **`agent-path-invoke.mjs` never invokes the agent path itself.** (F-DEPLOY-1/F-DEPLOY-3/F-DEPLOY-4.)
  Unlike the CDP-bridged live steps, there is no `window.*` route for the `runtimeInvoke` self-tool to
  connect to — see "Class-killer: agent-path invoke" above. A `pass` on its `installed-api` receipt proves
  the supplied envelope carried a provenance-bound runtime-receipt AND classified into exactly the outcome
  the operator declared they expected — not that the expectation itself was the right one for that
  capability in the abstract; that judgment (what SHOULD this capability do under normal policy) is still
  the operator's/report's to make, this gate only proves the declared expectation held.

## Requirements

- Repo dependencies installed (`pnpm install`); this facility reuses `@marshal/runtime`,
  `@playwright/test`, and `chrome-remote-interface`, all already repo dependencies.
- Node ≥ 22 (matches the repo).
- For the native-frame regression suite: a Chromium build available to
  `@vitest/browser-playwright` (already required by the repo's own `pnpm test` browser project).
- For live mode only: an already-running Marshal with a CDP debug port open (`pnpm electron:debug`).

## Directory layout

```
host-smoke/acceptance-facility/
├── README.md                     — this file
├── lib/                          — shared, framework-agnostic helpers (+ unit tests)
│   ├── evidence-classes.mjs      — the seven evidence-class ids + status validation
│   ├── receipt.mjs               — receipt builder/writer/reader/summarizer
│   ├── redact.mjs                — secret redaction
│   ├── declared-permission-broker.mjs — no-allow-all RuntimeKernel PermissionBroker
│   ├── kernel-mock-harness.mjs   — registers the sample app in a real RuntimeKernel
│   ├── provider-comparisons.mjs  — account-scope/known-PR/authorized-write comparison helpers
│   ├── provider-acceptance-mode.mjs — decides fixture vs. live evidence source (never fabricates live)
│   ├── live-connection.mjs       — CDP connectors (chrome-remote-interface + Playwright)
│   ├── live-scope-discovery.mjs  — picks the REAL scope (session, or the persistent user scope for a
│   │                                nav-opened instance) that owns the target's open instance (checks
│   │                                every open session PLUS the persistent scope, never assumes the
│   │                                first), or an operator-pinned override; typed refusal on ambiguity
│   │                                (L2-005 + residual, branch (ii))
│   ├── identity-verification.mjs — pass/fail decision for the installed-api identify receipt
│   ├── capability-invoke-verification.mjs — request/result validation for the installed-api execute receipt
│   ├── frame-geometry.mjs        — builds the DOM expression that measures a matched instance's real iframe rect
│   ├── agent-invoke-classification.mjs — classifies a real agent-path invoke envelope into one of five
│   │                                distinct outcomes (F-DEPLOY-1/F-DEPLOY-3/F-DEPLOY-4 class-killer)
│   ├── agent-invoke-gate.mjs      — the class-killer step's acceptance gate: provenance-bound receipt +
│   │                                declared-expectation assertion (pass-by-classification abolished)
│   └── run-command.mjs           — cross-platform pnpm invocation
├── sample-app/                   — the fixture "installed" application
│   ├── index.html
│   ├── manifest.mjs
│   ├── capability-provider.mjs
│   └── provider-fixtures.mjs
├── native-frame/                 — isolated Vitest project (native-frame evidence)
│   ├── vitest.config.ts
│   ├── vite-env.d.ts
│   └── controlled-scenarios.browser.test.tsx
├── scripts/                      — one script per audit point, + run-all.mjs
└── example-receipts/             — generated by scripts/run-all.mjs; committed as worked examples
```
