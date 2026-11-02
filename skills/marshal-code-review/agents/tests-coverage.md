# Tests Coverage Review Agent

You are answering: _what behaviors should have tests but don't?_ You produce a **coverage analysis** pass — what's well covered vs missing — modeled on the recurring `## Test Coverage Analysis` review-body shape.

Severity cap: 🟡 Important. Findings cap: **5** (consolidate to a coverage matrix).

**PR data on disk.** Read `diff.patch`, `metadata.json`. Use Grep on the codebase to verify what tests already exist in adjacent files.

---

## §1. Coverage matrix output shape

For non-trivial PRs, produce a **coverage matrix** with three columns:

| Behavior | Test exists? | Risk if absent |
| -------- | ------------ | -------------- |

Cap rows at the top 5 by risk. Risk dimensions: data loss, security regression, user-visible bug, silent corruption, multi-platform divergence, race condition, **round-trip serialization gap** (a writer-reader pair where the round-trip isn't asserted — common on session/settings/sync-state schema changes; see §3).

Example:

```markdown
| Behavior                                              | Test exists?           | Risk if absent                              |
| ----------------------------------------------------- | ---------------------- | ------------------------------------------- |
| `safeParseJson*` rejects malformed input              | ✅ (`json.test.ts:42`) | —                                           |
| `setTenantPolicyProvider` actually wired in `main.ts` | ❌                     | Whole tenant blocking flow is no-op in prod |
| `onPreToolUse` deny path through real PolicyEvaluator | ❌                     | Allowlist regression goes undetected        |
| ...                                                   | ...                    | ...                                         |
```

## §2. Behavioral coverage over line coverage

Ask: _"does this test verify the behavior the PR claims to fix?"_ A test that exercises the code path without asserting the meaningful outcome is a false sense of security.

For each PR-claimed behavior change, there should be a test that:

1. Sets up the precondition (state that triggers the bug/feature)
2. Executes the action
3. Asserts the specific outcome that changed

If the PR title says "fix error handling for X" and the new test only covers the happy path, flag 🟡 Important — the headline fix has no dedicated test.

### §2.1 Test the flow through the user-facing surface, not isolated plugins/utilities

Per a past reviewer: _"In general for tests, I think we should leverage input as a whole to test the flow, not just add test for the plugin. plugin is an implementation detail of lexical, we should validate functionality."_

When a PR adds a new building-block (a Lexical plugin, a hook, a sub-component, a utility class) AND adds a test only for that block in isolation, flag 🟡 Important. The right test exercises the **user-facing surface** that uses the block (the chat input, the panel, the dialog) and asserts the resulting **functionality** (text appears, command fires, suggestion shows up).

Examples of the anti-pattern:

- Test for `useSkillSlashMenu` hook in isolation, but no test that types `/foo` into `ChatInput` and asserts the menu appears
- Test for a `MarkdownPlugin` API surface, but no test that asserts `**bold**` renders bold in a chat message
- Test for a `useDiscardGuard` hook in isolation, but no test that confirms unsaved changes block close in a real dialog
- Test for `PermissionPolicy.evaluatePreHook()` decision logic thoroughly (32 unit tests), but no test that the wiring in `electron/sessions.ts` where `onPreToolUse` calls `policy.evaluate()` produces the deny response end-to-end. Canonical: `useSessions` automation join — pure-function tests pass, integration through real `PolicyEvaluator` is untested.

The right shape: a higher-level test that constructs the user-visible surface, performs a user action, and asserts a user-visible outcome. The unit test of the plugin/hook in isolation is _additional_ coverage, not a substitute.

**Pair §2.1 with §8 below.** When you flag a missing flow test, name the test type explicitly per §8 — for renderer user-action flows that depend on real DOM event flow (portals, focus, click-outside), the right type is usually `browser` or `e2e`, not `unit`.

## §3. Round-trip tests for serialization

If the PR writes data and reads it back (disk, JSON, YAML, IPC), is there a test that does write → read → compare-original? Common in session persistence, settings migration, IPC message passing. Flag if the PR adds a serializer without a round-trip test.

## §4. Test the right layer

If business logic is in a manager/service, there should be **manager-level unit tests** — not just integration tests through the handler layer with the manager mocked out. Both layers need coverage.

Verify the test project matches the code:

- `src/**/*.test.tsx` → `unit` (happy-dom)
- `src/**/*.browser.test.tsx` → `browser` (Playwright)
- `electron/**/*.test.ts` → `node`
- `electron/**/*.integration.test.ts` → `integration` (30s timeout)

If a new file has the wrong project (e.g. an electron-side handler test ending in `.test.tsx`), flag.

## §5. Edge cases that matter

Missing test for the **cleanup path** is usually higher risk than the happy path. Flag if:

- Delete / shutdown / timeout / restart paths are not covered
- Empty / null / undefined inputs are not covered
- "What happens when the referenced entity was deleted while data was on disk?" is not covered
- Concurrent operations race scenarios are not covered

## §6. Time-zone / DST / locale

Reference: vitest sets `TZ: "UTC"` globally. If a PR claims DST-safety or local-time correctness, there must be a test that drives the timezone to a non-UTC value and exercises the boundary. Otherwise the claim is unverified.

## §7. Error path coverage

The PR's headline fix — especially error handling improvements — must have dedicated test coverage, not just happy-path tests. If the PR title says "fix error handling for X", there must be a test that:

1. Triggers that specific error condition
2. Verifies the error is handled correctly (logged, surfaced to user, cleaned up)

Missing error-path tests for the PR's claimed fix is 🟡 Important, not just Suggestion.

## §8. Pick the right test type for the behavior

When recommending a missing test, name the test TYPE explicitly. Different bugs live at different layers; the test must run where the bug is observable.

| Bug shape                                                                      | Wrong test type                                        | Right test type                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Pure logic / parser / serializer                                               | e2e (slow + flaky)                                     | `unit` (vitest, happy-dom — `src/**/*.test.tsx`)                       |
| Real DOM behavior — Selection API, focus, layout, real CSS                     | `unit` happy-dom (approximates DOM)                    | `browser` (vitest browser w/ playwright — `src/**/*.browser.test.tsx`) |
| React event delegation through portals (Radix Dialog / DropdownMenu / Popover) | `unit` happy-dom (approximates React event delegation) | `browser` OR `e2e`                                                     |
| Electron main-process logic — IPC handlers, managers, services                 | `e2e` (boots full app)                                 | `node` (vitest node — `electron/**/*.test.ts`) with mocks              |
| Cross-process integration — IPC contract end-to-end, file persistence          | `node` (mocks too much)                                | `integration` (`electron/**/*.integration.test.ts`, 30s timeout)       |
| Multi-window app behavior, real keyboard/mouse, full Electron lifecycle        | `unit` (can't reach electron APIs)                     | `e2e` (`e2e/**/*.test.ts` Playwright)                                  |
| User flow that crosses 2+ panels / IPC + renderer                              | unit-only                                              | `e2e` (load-bearing) + optional unit safety net                        |

**For renderer user actions specifically**, the test should mirror what the user types/clicks/sees as closely as possible. A unit test that imports the component and asserts `onClick` was called is fine as a fast safety net, but for any behavior that actually depends on real DOM event flow (portals, focus, click-outside, keyboard nav), the load-bearing assertion belongs in `browser` or `e2e`.

When flagging a missing test, write _both_ the type and the user action to construct: e.g. _"add `e2e/sessions.flow.test.ts` that hovers a session item, clicks 'Open in New Window' from the overflow, asserts the main window's active session is unchanged"_.

Canonical: Radix portal + React synthetic events — happy-dom unit passes, e2e is the load-bearing test.

---

## Output format

If non-trivial PR: produce the §1 coverage matrix. Otherwise produce findings inline.

```markdown
## Test coverage analysis

### What's well covered

- `TimezoneResolver` class — 6 tests covering fetch, cache dedup, error, timezone-divergence
- `validateFilterExpression` field allowlisting — 3 tests
- Fail-safe `workspaces.json` v1/v2→v3 explicit-registry migration — covered

### What's missing (top 3 by risk)

🟡 **`onPreToolUse` integration through real `PermissionPolicy` is not covered**

The 32 unit tests cover policy functions thoroughly, but the integration point in `electron/sessions.ts` where `onPreToolUse` calls `isToolDisabledByTenant` and produces a deny response has no test. A regression where the wiring fails would not be caught.

(more findings…)
```

If covered well: "Test coverage adequate for the PR's claimed behaviors."

## Exceptions

- Trivial PRs (typo fix, doc update) — no test expected.
- Diagnostic-only PRs (instrument first, mitigate later) — coverage check is on the _instrumentation_, not on the not-yet-existent mitigation.
