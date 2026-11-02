<!-- Marshal-owned code-review guidance. -->
# Reuse existing codebase primitives

- Status: retired
- Retired on: 2026-05-06 — superseded by `agents/renderer-primitives.md` §1 ("Reuse existing codebase primitives"). Kept for provenance.
- Review surface: `renderer`

## Guideline

When adding a hook, context provider, type definition, or UI primitive, check whether the codebase already provides one before introducing a new implementation.

## Why

Duplicate abstractions drift silently, inflate the bundle, and confuse contributors who don't know which copy to use — especially when an AI agent generates code without searching the existing codebase first.

## Detection signal

In `src/**/*.tsx`, `src/hooks/**/*.ts`, `src/components/ui/**`, and type definition files, look for:

- A new `useState` + `useEffect` hook that replicates an existing shared hook (e.g., theme detection, media queries, settings access)
- A re-declared interface or type that duplicates one in `common/marshal-ipc-contract.ts` or another shared module
- A wrapper provider (`TooltipProvider`, `ThemeProvider`, etc.) already mounted at the app root
- A hand-rolled UI component when a shadcn primitive is already in `src/components/ui/`

## Example

```tsx
// sonner.tsx — reimplements theme detection from scratch
function useAppTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
```

The codebase already has `useTheme` in `src/hooks/useTheme.ts`.

## Exceptions

- The existing abstraction genuinely doesn't fit (different API surface, different lifecycle, incompatible assumptions) — explain why in the PR
- A new component is being scaffolded from shadcn's CLI and will replace the existing one (i.e., an intentional upgrade)
- Test utilities that intentionally redefine a minimal stub of a production type

<details>
<summary>Provenance</summary>

- Derived from 5 comments across 4 PRs merged to `main` between `2026-04-01` and `2026-04-21`.
- Reviewer: an upstream reviewer; top-priority coverage 4/4 PRs.
- Evidence:
  - `src/hooks/useTenantPolicy.ts` — type recreated instead of imported from ipc-contract
  - `src/features/settings/Sections/PermissionsSection.tsx` — redundant TooltipProvider already at app root
  - `src/features/settings/Sections/PrivacySection.tsx` — raw label instead of shadcn Label
  - `src/components/ui/sonner.tsx` — reimplemented useTheme hook
  - `src/components/ui/alert.tsx` — verifying shadcn origin
- Single-reviewer limitation: all 5 comments from the reviewer. Manually promoted to `active` on 2026-04-21 by the reviewer (explicit approval).

</details>
