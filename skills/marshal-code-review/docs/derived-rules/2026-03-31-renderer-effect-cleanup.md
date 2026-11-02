<!-- Marshal-owned code-review guidance. -->
# Renderer effect cleanup

- Status: retired
- Retired on: 2026-05-06 — superseded by `agents/react.md` §2 ("Effects need cleanup; subscriptions need stable callbacks"). Kept for provenance.
- Review surface: `renderer`

## Guideline

When a renderer change adds timers, document-level listeners, debounced work, or terminal UI states around async flows, verify teardown on unmount and rollback on failure or manual override.

## Why

Timers, listeners, or terminal UI state that survive navigation or failures leave the UI stuck or fire stale work after the user has moved on.

## Detection signal

In `src/**/*.tsx` and other interactive panels, editors, streaming UI, or drag/resize surfaces, look for `setTimeout(...)`, debounce refs, `document.addEventListener(...)`, terminal UI state set before an `await`, or async handlers that never restore prior state on error.

## Example

```ts
const handleRestart = useCallback(async () => {
  if (!window.updateAPI) return;
  setState("restarting");
  await window.updateAPI.restart(filePath || undefined);
}, [filePath]);
```

If `restart()` throws, the banner can stay stuck in `"restarting"` forever.

## Exceptions

- local event handlers with no timers or external listeners
- async UI paths that already restore prior state on error
- listeners fully owned by a library component with guaranteed teardown outside this component

<details>
<summary>Provenance</summary>

- Derived from 4 comments across 3 PRs merged to `main` between `2026-03-10` and `2026-03-31`.
- Reviewer: an upstream reviewer; top-priority coverage 3/3 PRs.
- Evidence:
  - `src/components/UpdateBanner.tsx`
  - `src/components/FilePreview.tsx`
  - `src/components/CreatePanel.tsx`
  - `src/components/Chat/CollapsibleIndicator.tsx`
- Status decision: marked `active` for `agents/learned-patterns.md` on `2026-03-31`.

</details>
