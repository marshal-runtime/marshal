// electron/workflows/slot-resolver.ts
//
// FEAT-SLOTS resolver: translates `{ slot: "investigator" }`-style
// SpawnOptions into the concrete SessionManager-shaped opts the
// SpawnAdapter understands, plus an optional `promptPreamble` the engine
// must prepend to the first user message sent to the subagent.
//
// One model, four binding kinds:
//
//   repo-agent      → pass `agentName + workspaceName/repoPath`; the
//                     existing `selectRepositoryAgent` machinery in
//                     `electron/sessions.ts` loads the `.agent.md` from
//                     `<repoPath>/.github/agents/`.
//   create-agent    → identical to repo-agent at resolve time (the file
//                     was authored at install time).
//   shipped-agent   → read `<workflowDir>/<defaultAgent.agentMdPath>`,
//                     synthesize a preamble, spawn without `agentName`.
//   default-with-role → no agent; prepend
//                     `[ROLE]…\n[PERSONALITY]…\n\n` to the prompt.
//
// Backwards compat:
//   - `opts.agentName` without `opts.slot` → pass-through (legacy).
//   - `opts.slot` without a bindings map → throw (mis-configured install).
//   - Both `opts.slot` and `opts.agentName` set → throw (ambiguous).

import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentRequirement, SpawnOptions } from "@marshal/workflow-sdk";

import type { Binding, BindingsFile } from "../../common/workflows-contract";

export interface SlotResolutionContext {
  readonly workflowDir: string;
  readonly requirements: readonly AgentRequirement[];
  readonly bindings: BindingsFile;
  readonly externalGithubFolderPath?: string;
}

export interface ResolvedSlot {
  /** SpawnOptions with `slot` removed and resolution fields filled in. */
  readonly resolvedOpts: SpawnOptions;
  /**
   * If set, the engine must prepend this string + a newline gap to the
   * first user message dispatched to the subagent (whether via
   * `ctx.run`'s immediate prompt or the first `ctx.send` after
   * `ctx.spawn`).
   */
  readonly promptPreamble?: string;
}

export class SlotResolutionError extends Error {
  constructor(
    public readonly slot: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "SlotResolutionError";
  }
}

/**
 * Apply slot → binding resolution. Always returns a fresh `SpawnOptions`
 * object (does not mutate the caller's).
 */
export function resolveSlot(opts: SpawnOptions, ctx: SlotResolutionContext): ResolvedSlot {
  // Guard: mutually exclusive.
  if (opts.slot && opts.agentName) {
    throw new SlotResolutionError(
      opts.slot,
      `SpawnOptions cannot specify both 'slot' (${opts.slot}) and 'agentName' (${opts.agentName}). Pick one.`,
    );
  }
  // Legacy / no-slot path: pass through.
  if (!opts.slot) {
    return { resolvedOpts: opts };
  }

  const slot = opts.slot;
  const requirement = ctx.requirements.find((r) => r.slot === slot);
  if (!requirement) {
    throw new SlotResolutionError(
      slot,
      `Workflow has no agentRequirement matching slot '${slot}'. Declared slots: ${
        ctx.requirements.map((r) => r.slot).join(", ") || "(none)"
      }`,
    );
  }

  const binding = ctx.bindings.bindings[slot];
  if (!binding) {
    throw new SlotResolutionError(
      slot,
      `Workflow's binding map has no entry for slot '${slot}'. ` +
        `Re-install the workflow with a binding for every declared slot, or use 'kind: default-with-role'.`,
    );
  }

  switch (binding.kind) {
    case "repo-agent":
    case "create-agent":
      return resolveRepoAgent(opts, slot, binding, ctx);
    case "shipped-agent":
      return resolveShippedAgent(opts, slot, requirement, ctx);
    case "default-with-role":
      return resolveDefaultWithRole(opts, slot, requirement);
    default: {
      // Exhaustiveness guard — TS should already prevent this.
      const exhaustive: never = binding;
      throw new SlotResolutionError(
        slot,
        `Unrecognised binding kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function resolveRepoAgent(
  opts: SpawnOptions,
  slot: string,
  binding: Extract<Binding, { kind: "repo-agent" | "create-agent" }>,
  ctx: SlotResolutionContext,
): ResolvedSlot {
  const workspaceName = opts.workspaceName ?? binding.workspaceName;
  const repoPath =
    opts.repoPath ??
    (opts.githubFolderPath ? repoPathFromGithubFolder(opts.githubFolderPath) : undefined) ??
    (ctx.bindings.externalContextPath
      ? repoPathFromGithubFolder(ctx.bindings.externalContextPath)
      : undefined) ??
    (ctx.externalGithubFolderPath
      ? repoPathFromGithubFolder(ctx.externalGithubFolderPath)
      : undefined) ??
    ctx.bindings.targetRepoPath ??
    undefined;
  if (!workspaceName && !repoPath) {
    throw new SlotResolutionError(
      slot,
      `Binding for slot '${slot}' (kind=${binding.kind}, agentName=${binding.agentName}) ` +
        `requires a target repo. Re-install with targetRepoPath set, or pass workspaceName/repoPath in SpawnOptions.`,
    );
  }
  if (binding.kind === "repo-agent" && binding.requireRepoLocal && repoPath) {
    assertRepoLocalAgentExists({ slot, repoPath, agentName: binding.agentName });
  }
  const { slot: _drop, githubFolderPath: _dropGithubFolderPath, ...rest } = opts;
  return {
    resolvedOpts: {
      ...rest,
      agentName: binding.agentName,
      ...(workspaceName ? { workspaceName } : {}),
      ...(repoPath ? { repoPath } : {}),
    },
  };
}

function repoPathFromGithubFolder(githubFolderPath: string): string {
  const resolved = path.resolve(githubFolderPath);
  return path.basename(resolved).toLowerCase() === ".github" ? path.dirname(resolved) : resolved;
}

function assertRepoLocalAgentExists(args: {
  slot: string;
  repoPath: string;
  agentName: string;
}): void {
  const available = listRepoLocalAgentNames(args.repoPath);
  const normalized = args.agentName.trim().toLowerCase();
  const found = available.some((name) => name.trim().toLowerCase() === normalized);
  if (found) return;
  const names = available.join(", ") || "none";
  throw new SlotResolutionError(
    args.slot,
    `Slot '${args.slot}' requires repo-local agent '${args.agentName}' not found in ${path.join(
      args.repoPath,
      ".github",
      "agents",
    )}. Available agents: ${names}`,
  );
}

function listRepoLocalAgentNames(repoPath: string): string[] {
  const agentsDir = path.join(repoPath, ".github", "agents");
  if (!fs.existsSync(agentsDir)) return [];
  const names: string[] = [];
  for (const filePath of listMarkdownFiles(agentsDir)) {
    const basename = path.basename(filePath).replace(/\.(agent\.)?md$/i, "");
    const raw = fs.readFileSync(filePath, "utf-8");
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    const frontmatter = match?.[1] ?? "";
    const name = frontmatter
      .match(/^name:\s*(.+)$/m)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
    names.push(name || basename);
  }
  return names;
}

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFiles(abs));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(abs);
  }
  return out;
}

function resolveShippedAgent(
  opts: SpawnOptions,
  slot: string,
  requirement: AgentRequirement,
  ctx: SlotResolutionContext,
): ResolvedSlot {
  const agentMdPath = requirement.defaultAgent?.agentMdPath;
  if (!agentMdPath) {
    throw new SlotResolutionError(
      slot,
      `Binding for slot '${slot}' is 'shipped-agent' but the workflow's agentRequirement declares no defaultAgent.agentMdPath.`,
    );
  }
  const abs = path.resolve(ctx.workflowDir, agentMdPath);
  if (!fs.existsSync(abs)) {
    throw new SlotResolutionError(
      slot,
      `Shipped agent file missing at ${abs} for slot '${slot}'. Re-bundle the workflow.`,
    );
  }
  let body: string;
  try {
    body = fs.readFileSync(abs, "utf-8");
  } catch (err) {
    throw new SlotResolutionError(
      slot,
      `Failed to read shipped agent at ${abs}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const preamble = buildShippedPreamble({
    slot,
    role: requirement.role,
    agentMdPath,
    body,
  });
  const { slot: _drop, ...rest } = opts;
  return {
    resolvedOpts: rest,
    promptPreamble: preamble,
  };
}

function resolveDefaultWithRole(
  opts: SpawnOptions,
  slot: string,
  requirement: AgentRequirement,
): ResolvedSlot {
  const preamble = buildDefaultPreamble({
    slot,
    role: requirement.role,
    personality: requirement.defaultPersonality,
  });
  const { slot: _drop, ...rest } = opts;
  return {
    resolvedOpts: rest,
    promptPreamble: preamble,
  };
}

function buildShippedPreamble(args: {
  slot: string;
  role: string;
  agentMdPath: string;
  body: string;
}): string {
  return [
    `--- Workflow slot binding (kind: shipped-agent) ---`,
    `Slot: ${args.slot}`,
    `Role: ${args.role}`,
    `Source: ${args.agentMdPath} (shipped with the workflow)`,
    `Follow the instructions below as your operating contract for this turn and any follow-ups in this session.`,
    ``,
    args.body.trim(),
    ``,
    `--- End slot binding ---`,
    ``,
  ].join("\n");
}

function buildDefaultPreamble(args: { slot: string; role: string; personality?: string }): string {
  const lines = [
    `--- Workflow slot binding (kind: default-with-role) ---`,
    `Slot: ${args.slot}`,
    `Role: ${args.role}`,
  ];
  if (args.personality) {
    lines.push(`Personality: ${args.personality}`);
  }
  lines.push(
    `You are a vanilla general-purpose subagent; the workflow author did not provide a custom agent file for this slot. Adopt the role and personality above for this run.`,
    `--- End slot binding ---`,
    ``,
  );
  return lines.join("\n");
}

/**
 * Helper for callers that want to know up-front whether a SpawnOptions
 * call requires resolution. Pure / no FS.
 */
export function isSlotSpawn(opts: SpawnOptions): boolean {
  return typeof opts.slot === "string" && opts.slot.length > 0;
}
