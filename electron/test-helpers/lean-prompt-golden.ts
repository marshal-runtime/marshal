import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { toClaudeQueryOptions } from "../backend/claude/config";
import { ClaudeToolInvocationRegistry } from "../backend/claude/tool-invocations";
import type { AssembleMarshalPromptInput } from "../prompt/assemble";
import type { ExtensionPromptContribution } from "../prompt/extension-contributions";

export const GOLDEN_DIR = path.join(__dirname, "..", "prompt", "golden");

const FILLER = (label: string, lines: number) =>
  Array.from(
    { length: lines },
    (_, index) =>
      `- ${label} rule ${index + 1}: keep the change small, name things precisely, and verify with the narrowest check.`,
  ).join("\n");

const FIXTURE_FILES: Record<string, string> = {
  "AGENTS.md": `# AGENTS.md\n\nInstructions for AI coding agents.\n\n${FILLER("agents", 12)}\n`,
  "CLAUDE.md": `# CLAUDE.md\n\nClaude Code project memory.\n\n${FILLER("claude", 10)}\n`,
  ".claude/CLAUDE.md": `# Local Claude notes\n\n${FILLER("claude-local", 3)}\n`,
  ".claude/rules/testing.md": `# Testing\n\n${FILLER("testing", 8)}\n`,
  ".claude/rules/go.md": `---\npaths:\n  - "**/*.go"\n---\n# Go\n\n${FILLER("go", 6)}\n`,
  ".claude/commands/ship.md": `---\ndescription: Ship the current branch\n---\nRun the release checklist.\n`,
  ".cursor/rules/always/general.mdc": `---\ndescription: Core behavioral rules for every change\nglobs:\nalwaysApply: true\n---\n${FILLER("general", 40)}\n`,
  ".cursor/rules/always/small.mdc": `---\ndescription: Prefer walrus operators\nalwaysApply: true\n---\n${FILLER("small", 3)}\n`,
  ".cursor/rules/always/testing-mirror.mdc": `---\ndescription: Testing standards\nalwaysApply: true\n---\n# Testing\n\n${FILLER("testing", 8)}\n`,
  ".cursor/rules/scoped/py.mdc": `---\ndescription: Python conventions\nglobs: **/*.py\n---\n${FILLER("python", 5)}\n`,
  ".cursor/rules/misc.mdc": `---\ndescription: Miscellaneous guidance applied when relevant\n---\n${FILLER("misc", 4)}\n`,
  ".cursor/commands/review.md": `---\ndescription: Review the diff\n---\nReview carefully.\n`,
  ".github/copilot-instructions.md": `# Copilot instructions\n\n${FILLER("copilot", 6)}\n`,
  ".github/instructions/ts.instructions.md": `---\napplyTo: "**/*.ts"\ndescription: TypeScript conventions\n---\n${FILLER("ts", 5)}\n`,
  ".github/agents/reviewer.md": `---\nname: reviewer\ndescription: Reviews pull requests\n---\nReview pull requests.\n`,
  ".github/hooks/pre-push.md": `---\nname: pre-push\ndescription: Checks before pushing\n---\nRun checks.\n`,
  ".github/prompts/triage.prompt.md": `---\ndescription: Triage an issue\n---\nTriage.\n`,
  "services/api/AGENTS.md": `# API service\n\n${FILLER("api", 4)}\n`,
  "services/api/CLAUDE.md": `# API service (Claude)\n\n${FILLER("api-claude", 4)}\n`,
};

export function createGoldenRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lean-prompt-golden-"));
  for (const [relativePath, content] of Object.entries(FIXTURE_FILES)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

export function removeGoldenRepo(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

export const GOLDEN_RUNTIMES = ["claude", "cursor", "codex", "copilot"] as const;

const BRAIN: ExtensionPromptContribution = {
  identity: "@marshal/brain",
  version: "0.1.0",
  health: "healthy",
  title: "Brain",
  description: "Code knowledge index and linked memories",
  guidance: {
    purpose: "this workspace's code and linked memories",
    when: "Code questions: first, before grep.",
    recipe: "knowledge.search {query} → hits[].node {path,id}.",
    boundaries: "Index may lag edits; open files first.",
  },
  capabilityPrefixes: ["knowledge.", "memory."],
};

const SWARM: ExtensionPromptContribution = {
  identity: "@marshal/swarm",
  version: "0.1.0",
  health: "healthy",
  title: "Swarm",
  description: "Recursive multi-agent runs",
  guidance: {
    purpose: "Recursive multi-agent swarm runs.",
    when: "A task decomposes into a coordinated multi-agent run.",
    boundaries: "Launching a swarm spends significant tokens.",
  },
  capabilityPrefixes: ["swarm.runs."],
};

const BLOCKED: ExtensionPromptContribution = {
  identity: "@example/blocked",
  version: "1.0.0",
  health: "blocked",
  blockReason: "missing permission",
  capabilityPrefixes: ["example."],
};

const ALL_ON = { browserEnabled: true, communicationsEnabled: true, directoryEnabled: true };

export interface GoldenAssembleCase {
  readonly name: string;
  readonly input: (repoCustomizations: string) => AssembleMarshalPromptInput;
}

const TAIL = (repoCustomizations: string) =>
  [
    "The user's timezone is Asia/Jerusalem. The current date and time is injected on every user turn by the host.",
    repoCustomizations,
    "## Skills\n- goals: durable goals\n- pptx: presentations",
    "## Memory\n- [preference] keep answers short",
    "## Workspace\nWorking in workspace `demo`.",
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");

export const GOLDEN_ASSEMBLE_CASES: readonly GoldenAssembleCase[] = [
  {
    name: "claude-main-with-repo",
    input: (repo) => ({
      role: { isSubagent: false, isWorkspaceScopedMain: false },
      includeClaudeTooling: true,
      includeHostTools: true,
      runtimeAvailable: true,
      trustedTypeScript: true,
      extensionContributions: [BRAIN, SWARM, BLOCKED],
      availability: ALL_ON,
      sessionContext: TAIL(repo),
    }),
  },
  {
    name: "claude-main-no-repo-brokered",
    input: () => ({
      role: { isSubagent: false, isWorkspaceScopedMain: false },
      includeClaudeTooling: true,
      includeHostTools: true,
      runtimeAvailable: true,
      extensionContributions: [],
      availability: {
        browserEnabled: false,
        communicationsEnabled: false,
        directoryEnabled: false,
      },
      sessionContext: TAIL(""),
    }),
  },
  {
    name: "claude-subagent-with-repo",
    input: (repo) => ({
      role: { isSubagent: true, isWorkspaceScopedMain: false },
      includeClaudeTooling: true,
      includeHostTools: true,
      runtimeAvailable: true,
      trustedTypeScript: true,
      extensionContributions: [BRAIN],
      availability: ALL_ON,
      sessionContext: `${TAIL(repo)}\n\n## Subagent Context\nParent session: demo.`,
    }),
  },
  {
    name: "claude-workspace-main",
    input: (repo) => ({
      role: { isSubagent: false, isWorkspaceScopedMain: true },
      includeClaudeTooling: true,
      includeHostTools: true,
      runtimeAvailable: true,
      trustedTypeScript: true,
      extensionContributions: [BRAIN, SWARM],
      availability: ALL_ON,
      sessionContext: TAIL(repo),
    }),
  },
  {
    name: "cursor-main-no-claude-tooling",
    input: (repo) => ({
      role: { isSubagent: false, isWorkspaceScopedMain: false },
      includeClaudeTooling: false,
      includeHostTools: true,
      runtimeAvailable: true,
      trustedTypeScript: true,
      extensionContributions: [BRAIN],
      availability: ALL_ON,
      sessionContext: TAIL(repo),
    }),
  },
  {
    name: "swarm-worker-restricted-surface",
    input: () => ({
      role: { runtimeAgentRole: "worker", isSubagent: true, isWorkspaceScopedMain: false },
      includeClaudeTooling: false,
      includeHostTools: false,
      runtimeAvailable: false,
      extensionContributions: [],
      availability: {
        browserEnabled: false,
        communicationsEnabled: false,
        directoryEnabled: false,
      },
      sessionContext: TAIL(""),
    }),
  },
];

export const GOLDEN_TOOL_OPTION_CASES: ReadonlyArray<{
  readonly name: string;
  readonly config: Parameters<typeof toClaudeQueryOptions>[0]["config"];
}> = [
  { name: "unrestricted-main", config: { systemMessage: { content: "x", mode: "replace" } } },
  {
    name: "allowlist-with-host-tools",
    config: {
      availableTools: ["Read", "Skill", "runtimeSearch"],
      tools: [
        {
          name: "runtimeSearch",
          description: "search",
          parameters: { type: "object", properties: {} },
          handler: () => Promise.resolve(""),
        },
      ],
    },
  },
  { name: "tool-free", config: { availableTools: [] } },
  { name: "no-project-context", config: { projectContext: false } },
];

export function summarizeClaudeToolOptions(
  config: Parameters<typeof toClaudeQueryOptions>[0]["config"],
): unknown {
  const options = toClaudeQueryOptions({
    client: { workspaceDir: "/workspace", env: { PATH: "bin" } },
    config,
    sessionId: "11111111-1111-4111-8111-111111111111",
    resume: false,
    toolAliases: {},
    invocations: new ClaudeToolInvocationRegistry(),
  });
  return {
    tools: options.tools ?? null,
    skills: options.skills ?? null,
    settingSources: options.settingSources ?? null,
    hasDisallowedTools: "disallowedTools" in options,
    hasToolAliases: "toolAliases" in options,
    mcpServerNames: options.mcpServers ? Object.keys(options.mcpServers) : null,
  };
}
