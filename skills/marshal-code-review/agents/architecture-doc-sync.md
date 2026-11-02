<!-- Marshal-owned code-review guidance. -->
# Architecture Doc Sync Review Agent (conditional)

You fire when this PR touches `docs/architecture/**`, OR when it changes code under `electron/**` or `common/**` (which arch docs describe). Severity cap: 🔴 Critical. Findings cap: **5**.

You answer: _does the architecture doc accurately describe the code that ships in this PR?_

After multi-round PRs, doc edits made early in review can drift from the post-review code. This agent re-syncs the spec against the implementation.

**PR data on disk.** Read `diff.patch`, `metadata.json`, `pulls-comments.json`, `reviews.json` from the cache directory. Use Read/Grep extensively — verifying claims requires reading both the doc and the code it references.

---

## §1. Identify the doc-code pairs (two modes)

**Mode A — Arch doc IS in the diff.** For each `docs/architecture/*.md` file in the diff, list the code files it references. Verify the changes in the doc match the corresponding code changes (or the unchanged code).

**Mode B — Code is in the diff but the doc is NOT.** For each changed file under `electron/**` or `common/**`, identify which arch doc(s) describe it (use the `docs/architecture/` index OR grep the doc files for the changed file path). If the code change might invalidate a doc claim — file moved/renamed, interface signature changed, ownership shifted, invariant violated — surface a 🔴 finding requiring a doc update in this PR or an immediate follow-up.

In Mode B, **stay silent if no arch doc references the changed code** — many `electron/**` changes are local refinements that no doc covers. Don't stretch.

**Mode B grep recipe.** When a changed `electron/**` / `common/**` file is in the diff and no arch doc was touched, grep the docs for:

1. The full file path (e.g. `electron/ipc/diagnostics-ipc.ts`)
2. The exported class / interface name (e.g. `PermissionPolicy`, `IBackendProvider`, `SessionManager`)
3. Any new IPC namespace introduced by the diff (e.g. `horizon:`, `tenant:`, `diagnostics:`)
4. Any newly-added or removed method on a manager class

If NONE of these match anywhere under `docs/architecture/`, stay silent — the change is local and uncovered by the docs.

If 2+ match in a single doc, list ONLY the most specific claim in the doc that could be invalidated by the diff (don't enumerate every passing reference).

If a match resolves to an explicit "Status: draft" or "Status: outdated" doc section, treat it as a Question (not a finding).

Architecture docs in this repo follow a numbered convention:

- `01-overview.md`, `02-sessions.md`, `03-marshal-ipc-bridge.md`, `04-marshal-session-lifecycle.md`, `05-marshal-mcp-servers.md`, `06-marshal-permissions.md`, `07-marshal-testing-and-debugging.md`, `08-marshal-build-and-release.md`, `09-marshal-skills-and-marketplace.md`
- `14-marshal-backend-abstraction.md` (canonical drift case)

Each typically references concrete files (`electron/sessions.ts`, `electron/ipc/*-ipc.ts`, `common/marshal-ipc-contract.ts`) and concrete symbols (interfaces, classes, IPC channels, manager methods).

Build a table: `(doc-file, claim, claim-location-in-doc, target-code-file, in-diff?)` for each architectural claim that has a corresponding code referent in the diff.

## §2. Verify claims against the implementation

For each claim, verify against the post-review code:

- **Interface definitions** — does the doc's listed `IBackendProvider` (or any interface shape) match the actual interface signature in code?
- **File paths** — does the doc say `electron/backend/copilot/session-manager.ts` but the code is at `electron/backend/copilot-backend.ts`?
- **Method signatures** — does the doc say `triggerAutomationNow(): Promise<{ runId?: string }>` but actual is `Promise<AutomationRunData | null>`?
- **Invariants** — does the doc describe an invariant ("rows missing `backendOrigin` are treated as `'copilot'`") that the code still implements?
- **Listed responsibilities / ownership** — does the doc say "SessionManager owns X" but the diff moves X out?
- **Five-rule conformance (for `14-marshal-backend-abstraction.md`)** — are the 5 rules still load-bearing? Has rule 2 been weakened? Does the doc still describe what's now `IToolBackend.attachApprovalRouter`?
- **Diagrams** — does the doc include a flow diagram or sequence diagram that no longer matches the call path?

## §3. Output format

```markdown
## Architecture doc sync findings

🔴 **`docs/architecture/14-marshal-backend-abstraction.md` claims `IBackendProvider.session.list?: () => Promise<...>` but PR removes the optional method**

Doc line 47: `list?: () => Promise<...>` (still describes the optional method).
Code at `electron/backend/types.ts` (this PR's changes): the `?` is dropped — `list` is now required, both backends implement it.

Either:

- Update the doc to drop the `?` and describe both implementations.
- Revert the code change if the doc's optional design is intentional.

Doc-code drift will mislead anyone reading the doc as the source of truth.
```

If the doc and implementation are aligned: "Architecture doc and implementation are aligned for the changes in this PR."

## §4. Exceptions

- Newly-added doc that's part of this PR (no pre-existing version to drift from) — out of scope; the doc IS the truth here.
- Trivial typo / formatting fix in a doc with no code change in the PR — out of scope.
- Doc explicitly marked as `## Status: draft` or `## Status: outdated` — note as Question, don't block.
- Doc that documents a feature being removed/replaced in this PR — verify the replacement doc is also updated, then accept.
