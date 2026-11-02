<!-- Marshal-owned code-review guidance. -->
# Model-facing contract honesty

- Status: retired
- Retired on: 2026-05-06 — promoted into `agents/main-process.md` (Input Validation & Security section, "Model-facing contract honesty" bullet). Kept for provenance.
- Review surface: `main-process`

## Guideline

When a PR changes model-visible tools, descriptions, or hidden hints, verify that the model-facing contract matches the runtime truth.

## Why

Dishonest tool metadata or hint-only control flow makes the model waste turns, mislead the user, or expose features that can never succeed.

## Detection signal

Look for changed tool descriptions, hidden formatting hints, or newly registered model-visible tools in `electron/self-tools.ts`, `electron/heartbeat.ts`, and similar registration surfaces.

## Example

```ts
export const ALL_SCOPES = [
  "User.Read",
  "People.Read",
  "Mail.ReadWrite",
  // TODO: Add "User.ReadBasic.All" for cross-user org queries
];
```

The tool becomes visible before the scopes that make it work exist.

## Exceptions

- internal helpers that are not exposed to the model
- tool registrations that are gated on capability or scope availability
- descriptions that already explain the limitation clearly

<details>
<summary>Provenance</summary>

- Derived from 5 comments across 5 PRs merged to `main` between `2026-03-10` and `2026-03-31`.
- Reviewers: two upstream reviewers; top-priority coverage 5/5.
- Evidence:
  - (removed relay IPC module)
  - `electron/heartbeat.ts`
  - (removed integration module)
  - (removed auth provider module)
  - `electron/self-tools.ts`
- Status decision: marked `active` for `agents/learned-patterns.md` on `2026-03-31`.

</details>
