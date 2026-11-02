<!-- Marshal-owned code-review guidance. -->

# Magic string to constant / config drift

- Status: candidate
- Review surface: `main-process`

## Guideline

When similar schemas, config-param mappings, or control-flow labels are written inline in multiple places, prefer a shared constant or config source if drift would change behavior or model-facing semantics.

## Why

Repeated inline schemas, positional config parsing, or control-flow sentinels drift silently when one copy changes and the others do not.

## Detection signal

In `electron/**/*.ts`, `common/**/*.ts`, `src/components/**/*.tsx`, `src/hooks/**/*.ts`, and tool registration, catalog, or settings surfaces, look for duplicated schema/property objects, `configArgs[0]`-style parsing, sentinel strings in control flow, or parallel nav/tool/config arrays that differ only slightly.

## Example

```ts
values.organization = configArgs[0] && !configArgs[0].startsWith("--") ? configArgs[0] : "";
values.project = configArgs[1] && !configArgs[1].startsWith("--") ? configArgs[1] : "";
```

This hardcodes one provider's argument ordering into a generic config flow and will drift when another provider defines different params.

## Exceptions

- one-off literal cleanup that is not part of a repeated semantic contract
- isolated rebrand or copy fixes with no second source to drift from
- internal literals that do not cross a model-facing or config-facing boundary

<details>
<summary>Provenance</summary>

- Derived from 4 comments across 4 PRs merged to `main` between `2025-04-01` and `2026-04-07`.
- Reviewer: an upstream reviewer; top-priority coverage 4/4.
- Evidence:
  - `electron/horizon.ts`
  - `electron/main.ts`
  - `src/components/Extensions/useExtensionsActions.ts`
  - (removed calendar integration module)
- Window note: this candidate used a 12-month sweep because the standard 3-week window never surfaced enough independent examples to preserve the pattern for later replay.
- Negative boundary: `electron/tray.ts` (`this.tray.setToolTip("M - AI Assistant")`) is a one-off rebrand cleanup, not durable constant/config drift evidence.
- Status decision: keep parked for now. The cluster is novel enough to preserve, but it is still dominated by one reviewer and mixes schema duplication, config parsing, sentinel strings, and duplicated nav arrays.

</details>
