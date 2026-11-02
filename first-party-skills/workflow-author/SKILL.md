---
name: workflow-author
description: 'Use this skill whenever the user wants to orchestrate multiple agents across multiple phases — patterns like "fan out across N PRs", "every repo", "run this pipeline weekly", "multi-step investigation", "build a custom report from several sources", or any time a single chat turn would need to coordinate dozens of subagents. Authoring a Marshal Dynamic Workflow produces a TypeScript file the engine runs deterministically with replay-on-crash, typed artifacts, per-run dashboards, and bounded subagent fan-out. Trigger keywords include "workflow", "pipeline", "orchestrate", "fan out", "for each PR/repo/bug/customer/file", "every Monday", "multi-agent", "review then file bugs", "reusable", "dashboard / grid / board view". Do NOT use this skill for single-shot subagent spawns — use spawnSubagent directly (see decision-tree.md). Do NOT use for simple time-based reminders — use createAutomation.'
---

# Workflow Author Skill

> **Deprecated for new authoring.** This skill documents Marshal's legacy
> Dynamic Workflows engine (`electron/workflows/**`), kept so existing
> installed workflows stay runnable, inspectable, and debuggable. Do not use
> it to author new workflows. If the user just wants a small recurring or
> on-demand script — not multi-agent fan-out across PRs/repos/files — point
> them at Workflow v2 instead: if the `@marshal/workflows` runtime extension
> is installed, create `~/.marshal/workflows/<name>/main.ts` (a plain
> TypeScript module, same shape as a `runtimeExecuteTypeScript` module,
> optionally scheduled via a sibling `workflow.json`, optionally given its
> own `ui.ts` pane view) — no install step required. This skill's
> multi-agent-orchestration authoring flow (fan-out, review-then-file-bugs,
> subagent pipelines) has no equivalent in Workflow v2 yet, so the rest of
> this document remains the reference for that case and for explaining any
> already-installed Dynamic Workflow.

You are about to author a **Marshal Dynamic Workflow** on the user's behalf.
The deliverable is one or two files dropped into a chosen directory:
`workflow.ts` (always) and `renderer.tsx` (only if generic UI isn't enough),
plus a `manifest.json`. The engine compiles them with esbuild at install time
and runs `workflow.ts`'s default export as a real TypeScript program.

## Quick Reference

| You need to…                                 | Read this first                                                      |
| -------------------------------------------- | -------------------------------------------------------------------- |
| Decide if a workflow is the right tool       | [decision-tree.md](decision-tree.md)                                 |
| Look up any `ctx.*` API                      | [cheatsheet.md](cheatsheet.md)                                       |
| Pick a composition pattern (fan-out, review) | [references/phase-patterns.md](references/phase-patterns.md)         |
| Avoid a known authoring failure mode         | [references/anti-patterns.md](references/anti-patterns.md)           |
| Write a custom React renderer                | [references/renderer-authoring.md](references/renderer-authoring.md) |
| Resolve a runtime error                      | [troubleshooting.md](troubleshooting.md)                             |
| Copy a complete worked example               | [examples/](examples/) (6 folders)                                   |
| Scaffold from a template                     | [templates/](templates/) (3 templates)                               |

## Trigger conditions

Invoke yourself (via `getSkill("workflow-author")`) when ANY of these is true:

- User says "workflow", "pipeline", "orchestrate", "for each X", "across all Y",
  or "every week/day".
- The work would require **3+ subagents** OR **2+ phases with a hand-off**.
- The user wants a **reusable thing** — "I want to run this regularly" /
  "save this so I can run it again".
- The work needs a **custom UI** to make sense (a grid, a board, a dashboard —
  not just a chat transcript).
- The user wants to **resume after a crash** or **retry from step N** without
  redoing everything.

Do NOT invoke for: a single sub-task ("go fix this in a worktree" →
`spawnSubagent`), an automation that's just "run prompt X every Monday at
9am" (→ `createAutomation`), or anything where one agent reading a few
files is the whole job.

## Procedure (the load-bearing 9 steps)

### Step 1 — Clarify with the user

Ask at most **five** questions, batched into a single `askUser` or one chat
message. Skip any whose answer is obvious. The fixed question set:

1. **Inputs** — what's the workflow's typed parameter shape? (date range? a
   list of items? a target repo?)
2. **Fan-out unit** — what is the workflow iterating over? (PRs, repos, bugs,
   languages, customers, database queries…)
3. **Identities** — does any phase need a specific agent identity (e.g. a
   repo-local `.github/agents/code-reviewer.md`)? If unknown, default to inline
   prompts and the `general-purpose` agent.
4. **Side effects** — does the workflow write anywhere external (chat
   messages, bug filing, PRs, files)? List them.
5. **Cadence** — one-shot, manual re-run, or scheduled? (Scheduled workflows
   are V1.1; for V1 the user can re-run manually.)

If you genuinely need none of these, do not ask — go straight to Step 2.

### Step 2 — Decompose into phases

For each user goal, pick a pattern from
[references/phase-patterns.md](references/phase-patterns.md). Common
decompositions:

- "Do X to every Y" → `sequential prep → dynamic-fanOut → sequential aggregate`.
- "Investigate then review then file" → `review-rework-loop` per unit inside
  a fanOut.
- "Pull from N sources and merge" → multiple `ctx.step` branches awaited
  together → join.

Phases are NOT a declared list — they emerge from your TS control flow. A
phase is "an `await ctx.step(...)` call".

### Step 3 — Pick agent identities (FEAT-SLOTS)

Workflows declare **slots** in `agentRequirements`, and each install binds
each slot to a concrete agent. This lets a single workflow ship with
sensible defaults (shipped agent.md files) AND get rebound per repo at
install time.

In the workflow source, reference slots by name:

```ts
defineWorkflow({
  // …
  agentRequirements: [
    {
      slot: "investigator",
      role: "Forensic analyst that re-verifies evidence.",
      defaultPersonality: "Cite evidence in every reply.",
      // Optional shipped agent.md (path relative to the workflow folder).
      // Omit for slots you expect the installer to bind per-repo.
      defaultAgent: { agentMdPath: "agents/investigator.agent.md" },
    },
    {
      slot: "summarizer",
      role: "Concise summarizer of bulky text.",
      defaultPersonality: "Reply in ≤5 bullet points.",
      // No defaultAgent: bundled install picks `default-with-role`.
    },
  ],
  run: async (ctx) => {
    // Use slot names at the call site:
    await ctx.run({ slot: "investigator", displayName: "Inv" }, prompt);
    await ctx.spawn({ slot: "summarizer", displayName: "Sum" });
  },
});
```

`SpawnOptions` accepts either `slot` or `agentName`, never both. Built-in
agent names (`general-purpose`, `explore`, `task`, `rubber-duck`,
`code-review`) still work directly via `agentName` without going through
a slot. Use slots whenever the workflow author wants to give the
installer choice about which agent personality satisfies the role.

`skills`, `mcp`, `model`, `reasoningEffort`, `permissionMode`, `repoPath`,
`createWorktree` remain per-spawn — slots only resolve identity.

**Model & reasoning effort.** Set `defaultModel` / `defaultReasoningEffort` on
`defineWorkflow` to pick the model + reasoning strength for the whole workflow
(host orchestrator + every spawn), overriding the workflow tier default
configured in Settings. Override per spawn with `model` / `reasoningEffort` on
`ctx.run` / `ctx.spawn`. When unset, sessions fall back to the workflow tier
default, then the system default (gpt-5.5 + High). Reasoning levels are
`"low" | "medium" | "high" | "xhigh"` (`xhigh` = the model's max).

### Step 4 — Scaffold `workflow.ts`

Start from `templates/workflow.template.ts`. Always include:

- `import { defineWorkflow } from "@marshal/workflow-sdk"` and
  `import { z } from "zod"`.
- A `params: z.object({...})` so the operator gets a typed form.
- One `defineWorkflow({ id, displayName, schemaVersion: 1, params,
run: async (ctx) => {...} })` default export.
- Every observable side-effect or expensive op wrapped in
  `ctx.step("<stable-id>", async () => {...})`.

Keep `workflow.ts` short and readable. Treat it as the orchestration table of
contents, not the place for every schema, prompt, helper, and data transform.
Use this default layout for non-trivial workflows:

```text
my-workflow/
  manifest.json
  workflow.ts              # orchestration only: steps, fanOut, ctx.run calls
  schemas.ts               # Zod input/output/unit schemas and exported types
  prompts.ts               # prompt builders that load markdown templates
  utils.ts                 # small pure helpers and formatting functions
  assets/
    prompts/
      investigate.md
      review.md
      summarize.md
```

Prompt bodies should live in `assets/prompts/*.md` and be loaded by a helper in
`prompts.ts` with `fs.readFileSync(path.join(__dirname, "assets", "prompts", ...))`.
The engine copies `assets/` into the run-local pinned directory, so this works
for installed and bundled workflows. Build prompts by importing the prompt
builder functions into `workflow.ts`; do not hard-code long multi-paragraph
prompts inline.

Prefer imports over local blobs: import Zod schemas from `schemas.ts`, prompt
builders from `prompts.ts`, and reusable helpers from `utils.ts`. If
`workflow.ts` grows past roughly 150 lines, split something out unless the
extra length is purely declarative phase wiring.

### Step 5 — Wire artifacts (typed access via Zod, free-form storage via SDK)

Artifacts are persisted bytes (encrypted-at-rest, run-scoped, namespaced under
fanOut). Use `ctx.saveArtifact(key, content)` and `ctx.readArtifact(key)`. If
the content is structured, JSON-stringify on write and `z.parse(JSON.parse(…))`
on read — share the Zod schema across writer and reader by importing from a
sibling `schemas.ts`. **Never** munge filenames as a poor man's data structure.

### Step 6 — Decide on custom renderer

You only need a custom renderer if the run is **semantically rich** — e.g. a
live grid, a board, a dashboard. For "show me the steps and their status",
the default renderer is fine. Default to **no renderer**. Read
[references/renderer-authoring.md](references/renderer-authoring.md) only if
the user explicitly asked for a custom view or the work is grid-shaped.

User-installed workflows may ship `renderer.tsx`. The install path compiles it
to `dist/renderer.js`, and the Workflows panel loads it for that workflow's run
detail slot. Renderer code must still be small, visual, and defensive: derive
state from `props.run` / `props.artifacts`, avoid direct Electron or filesystem
access, and let the built-in run header own cancel / retry / status controls.

### Step 7 — Author renderer (if Step 6 said yes)

Render `renderer.tsx` using the `WorkflowRunRendererProps<RunState>` contract.
No `fs`, no `child_process`, and no host tools — only the props the SDK passes
and Marshal's theme tokens.

### Step 8 — Place or hand off

For a repo-scoped workflow, write the complete source tree to:

```text
<repo>/.github/marshal-workflows/<workflow-id>/
```

Repo-local workflows are directly discoverable through `workflowList`,
`workflowDescribe`, and `workflowRun`; do not look for or call an install tool.
Use `listRepositoryAgents({ workspaceName })` before authoring bindings or new
`.agent.md` files for declared `agentRequirements`.

For a standalone/user-library workflow, leave a complete source directory and
tell the user to import it through the Workflows UI or authoring CLI. Import and
binding resolution are intentionally not model-facing APIs.

**If compile fails**, surface the esbuild error to the user verbatim and offer
to fix it — do not silently retry more than once.

Schedules are supported through `manifest.json` and the Workflows panel. If the
workflow should run on a cadence, put a human-readable schedule in
`manifest.json`, for example:

```json
{
  "schedule": "every weekday at 9am"
}
```

The app parses the same schedule formats as Automations. Scheduled runs reuse
the saved input JSON from the Workflows panel, so every scheduled workflow must
have sensible defaults or a clear input schema.

### Step 9 — Hand off

Single concluding message with three things and nothing else:

1. **What it does** (1 sentence).
2. **What it'll ask for** (params shape).
3. **One affordance** — the workflow id and the offer "want me to start a run
   now with X=…?".

Do NOT explain the TS source unless the user asks; they aren't reading it.

## Anti-patterns (do-not list — the most-cited authoring failures)

The full 14-item list lives in
[references/anti-patterns.md](references/anti-patterns.md). The five most
load-bearing are restated here for instant recall:

1. **DO NOT do work outside `ctx.step`.** Plain `await` of a side-effect at
   the workflow top level breaks replay.
2. **DO NOT use artifact filename munging.** Use `ctx.saveArtifact(key, …)`
   with stable keys and share Zod schemas across writer/reader.
3. **DO NOT put giant prompts or schemas in `workflow.ts`.** Keep prompt text in
   `assets/prompts/*.md`, schemas in `schemas.ts`, and pure helpers in
   `utils.ts` so the workflow remains easy to audit.
4. **DO NOT spawn unbounded subagents.** Always set `maxConcurrency` on
   `ctx.fanOut`; the per-run cap is a backstop, not a design.
5. **DO NOT skip the `runFamilyId` + `itemKey` in idempotent side effects.**
   Tag every external write with `[runFamily:${ctx.runFamilyId}, item:${b.key}]`
   and read-before-write. (`runFamilyId` is stable across replays / retries;
   `runId` is not.)
6. **DO NOT silently swallow `ctx.fanOut` unit failures.** Declare
   `onUnitFailure: { kind: "continue" }` only if you also handle the failed
   units explicitly downstream; default `{ kind: "fail-fast" }` otherwise.

## Locked contracts (V1)

This skill teaches the **V1** SDK surface, which is locked by `r1-fixes.md`.
Key naming locks:

- `ctx.input` (not `ctx.params`), `ctx.runId`, `ctx.runFamilyId`,
  `ctx.cancelled` (AbortSignal), `ctx.log` (not `ctx.logger`).
- Flat artifact API: `ctx.saveArtifact / readArtifact / listArtifacts`.
- `ctx.send` (not `ctx.message`).
- fanOut policy: `{ kind: "fail-fast" | "continue" | "budget" }`
  (NOT `minSuccessFraction` — that name is gone).
- 11 V1 self-tools: `workflowList`, `workflowRun`, `workflowGetRun`,
  `workflowListState`, `workflowReadState`, `workflowListArtifacts`,
  `workflowReadArtifact`, `workflowSaveArtifact`, `workflowCancel`,
  `workflowRetryFromStep`, `workflowDescribe`.
