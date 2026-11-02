# Renderer authoring (custom UI for a workflow run)

Loaded only when Step 6 said "yes, custom renderer needed". Note: V1 user-
installed workflows cannot ship custom renderers — only bundled workflows can.

## The three common shapes

### a. Grid of fanOut units

The workflow's main shape is one big fanOut over N items. Render a grid of
cards, one per unit, each subscribed to per-unit events.

```tsx
import type { WorkflowRunRendererProps } from "@marshal/workflow-sdk";
import { useMemo } from "react";

export function FanOutGrid(props: WorkflowRunRendererProps) {
  const units = useMemo(
    () => props.run.steps.filter((s) => s.stepKey.startsWith("process/")),
    [props.run.steps],
  );
  return (
    <div className="grid grid-cols-4 gap-2 p-2">
      {units.map((u) => (
        <div key={u.stepKey} className="rounded border border-(--border) bg-(--surface-1) p-2">
          <div className="text-sm font-medium text-(--text-primary)">{u.id}</div>
          <div className="text-xs text-(--text-secondary)">{u.status}</div>
        </div>
      ))}
    </div>
  );
}
```

### b. Pipeline view

The workflow is mostly sequential with one fanOut in the middle. The default
renderer already does this — only override if you want phase-specific visuals
(e.g. a richer artifact preview, an inline diff, a chart).

### c. Dashboard

The workflow's output is a synthesized view (e.g. on-call tracking or WSR).
Prefer a stable artifact key such as `dashboard.json` plus durable state keys
over deriving state from filenames. Renderers can use:

```tsx
const dashboard = await props.dashboard.readJsonArtifact("dashboard.json");
const cursor = await props.dashboard.getState("oncall/cursor");
const recentRuns = await props.dashboard.listRunHistory({ limit: 5 });
```

## React idioms

- All rendering is reactive over `props.run` and `props.artifacts`. The host
  re-renders the component when either changes.
- Use `useMemo` over any derived view; `props.run.steps` and `props.artifacts`
  are stable references when their contents haven't changed.
- Always render _some_ fallback when `props.run.steps.length === 0` — the
  run may have just started.

## Don'ts

- No `import "fs"`, no `import "electron"`, no `import "child_process"`,
  and no host-tool calls — there's literally no host API for those in the
  renderer's React context.
- No direct DOM mutation outside React.
- No fetching from arbitrary URLs — read from `props.artifacts` instead.
- No state held outside React (no module-level mutable, no `window.*`); a
  render can be unmounted on view change.
- **Theme tokens only** — `bg-(--surface-1)`, `text-(--text-primary)`, etc.
  No hard-coded colors, especially those that break in dark mode.

## Registration

```tsx
// renderer.tsx
import { defineRenderer } from "@marshal/workflow-sdk";
import { FanOutGrid } from "./FanOutGrid";

export default defineRenderer({
  workflowId: "my-workflow-id",
  render: (props) => <FanOutGrid {...props} />,
});
```

The loader binds this to `SLOT.WORKFLOW_RUN_DETAIL` with an `activateWhen`
predicate matching the `workflowId`, so it only renders for runs of this
workflow.
