<!-- Marshal-owned code-review guidance. -->
# Platform-native paths and fail-fast scripts

- Status: retired
- Retired on: 2026-05-06 — promoted into `agents/main-process.md` (Cross-platform parity bullet, "Build / release / support scripts"). Kept for provenance.
- Review surface: `main-process`

## Guideline

In build, test, release, and support scripts, prefer platform-native path helpers and explicit failure semantics over string-built paths or warning-only validation.

## Why

Hardcoded paths and non-terminating validation let cross-platform breakages or bad release artifacts slip past CI until much later.

## Detection signal

In `build/scripts/**/*.ps1`, `.github/workflows/**/*`, `e2e/**/*.ts`, and similar automation surfaces, look for `"/tmp/..."`, string-built paths like `"$dest/$($name)"`, platform ternaries used only for separators, or `Write-Error` in a step that should stop the pipeline.

## Example

```powershell
Copy-Item $exe.FullName "$dest/$($exe.Name)"
```

This works by accident on Windows, but it bakes in mixed separators instead of using `Join-Path`.

## Exceptions

- truly OS-specific scripts that intentionally target one platform only
- path values that come directly from helper APIs like `Join-Path`, `path.join()`, or `os.tmpdir()`
- warning-only scripts where continuing is explicitly the intended behavior

<details>
<summary>Provenance</summary>

- Derived from 4 comments across 4 PRs merged to `main` between `2026-03-10` and `2026-03-31`.
- Reviewers: two upstream reviewers; top-priority coverage 4/4.
- Evidence:
  - `e2e/perf.test.ts`
  - `electron/updater.ts`
  - (removed release pipeline definition)
  - `build/scripts/Stage-SignedInstaller.ps1`
- Status decision: marked `active` for `agents/learned-patterns.md` on `2026-03-31`.

</details>
