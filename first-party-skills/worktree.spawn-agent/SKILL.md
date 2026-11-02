---
name: worktree.spawn-agent
description: Launch and coordinate Marshal subagent sessions scoped to Co-create workspaces or git worktrees.
---

# Worktree Spawn Agent

Use this skill when the user asks you to delegate work to another agent, launch an agent in a worktree, coordinate parallel repo work, or inspect progress from subagent sessions.

## Workflow

1. Call `listWorkspaces` to see the projects and folders the user has added in Co-create.
2. Resolve informal project names against that list. If the user says "powerquery" and exactly one workspace matches, use that workspace name as the source repo.
3. For repo work, call `listRepositoryAgents` with the resolved `workspaceName` or explicit `repoPath` before spawning. If the user requested a specific agent, match that agent by name/path/description and pass it as `agentName`. If the user did not specify an agent, choose the best-fitting listed agent for the task and pass its `name`; omit `agentName` only when no repository agent fits or none exist.
4. Call `spawnSubagent` with `createWorktree: true`, the resolved `workspaceName` or explicit `repoPath`, the selected `agentName` when applicable, and a complete task prompt. This creates an internal git worktree and launches the subagent inside that path without adding it to the user's Co-create workspace list. Only call `registerWorkspace` separately when the user explicitly asks to expose that worktree as a workspace.
5. Choose `permissionMode` deliberately:
   - `default`: subagent permission prompts are shown on the parent session for approval.
   - `allow-all`: subagent tool calls are auto-approved without prompting unless tenant policy blocks them.
6. Use `baseRef` when the worktree should start from a specific branch or ref, and `branchName` only when the user needs a specific branch name. Otherwise let the tool generate a unique branch.
7. Continue orchestrating from the parent session with `listSubagents`, `getSessionTranscript`, and `messageSubagent`.
8. Ask subagents to use `messageParent` for blockers, progress updates, and final handoff notes.

## Model & reasoning effort

By default, **do not** set `model` or `reasoningEffort` when spawning. Plain subagents inherit the configured subagent default (model + reasoning level) from Settings → "Subagents & Workflows", and repo-scoped agents inherit their tier default. This is the right behavior almost always — leave both unset.

Only override when the **user explicitly asks** for a specific model or reasoning strength for the subagent (e.g. "run the reviewer on Opus with max reasoning", "spawn a quick agent on a cheaper model"). In that case:

1. Call `listModels` to get valid model ids and each model's supported reasoning-effort levels (`low` / `medium` / `high` / `xhigh`, where `xhigh` is the model's max).
2. Pass the chosen `model` and/or `reasoningEffort` to `spawnSubagent`. The `reasoningEffort` must be one the chosen model supports.
3. If the user only names a strength ("max reasoning") without a model, keep the default model and set `reasoningEffort` (e.g. `xhigh`); if they only name a model, set `model` and leave reasoning to inherit.

Never pick a non-default model or reasoning level on your own initiative for cost or speed reasons — that's the user's call.

## Prompting Subagents

Give each subagent a self-contained brief:

- objective and expected deliverable
- target workspace or repo
- the created worktree branch/path if `spawnSubagent` returned one
- the selected repository agent, if `spawnSubagent` returned `repositoryAgent`
- files, commands, tests, or constraints already known
- what to report back and when

Subagents are normal Marshal sessions with `source = "subagent"`. The user can open them directly from the session list, read their full history, and send messages to them like any other chat.
