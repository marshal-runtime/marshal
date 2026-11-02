import * as fs from "node:fs";
import * as path from "node:path";

import { stripYamlQuotes } from "../../foundation/yaml/skill-fields";
import { createRepositoryAgentIdentity } from "../../workspace-role-identity";
import type { RepositoryAgentDefinition, SkillProviderRoot } from "../types";

export interface RepositoryInstruction {
  path: string;
  content: string;
  source?: RepositoryCustomizationSource | "shared";
  /** True for unconditional rules; false for path-scoped or intelligently selected rules. */
  alwaysApply?: boolean;
  /** Source-declared path patterns. The runtime should load the body only when relevant. */
  appliesTo?: string[];
  description?: string;
}

export interface RepositoryArtifact {
  path: string;
  name: string;
  description: string;
}

export type RepositoryCustomizationSource = "copilot" | "cursor" | "claude";

export interface RepositoryCommandDefinition extends RepositoryArtifact {
  source: RepositoryCustomizationSource;
  instructions: string;
}

interface RepositoryConvention {
  source: RepositoryCustomizationSource;
  directory: ".github" | ".cursor" | ".claude";
  agentDirectory: string;
  skillDirectory: string;
  commandDirectory?: string;
}

const REPOSITORY_CONVENTIONS: readonly RepositoryConvention[] = [
  {
    source: "copilot",
    directory: ".github",
    agentDirectory: "agents",
    skillDirectory: "skills",
    commandDirectory: "prompts",
  },
  {
    source: "cursor",
    directory: ".cursor",
    agentDirectory: "agents",
    skillDirectory: "skills",
    commandDirectory: "commands",
  },
  {
    source: "claude",
    directory: ".claude",
    agentDirectory: "agents",
    skillDirectory: "skills",
    commandDirectory: "commands",
  },
] as const;

function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveDirectoryWithin(root: string, candidate: string): string | null {
  try {
    const canonicalRoot = fs.realpathSync(root);
    const canonicalCandidate = fs.realpathSync(candidate);
    return isWithinDirectory(canonicalRoot, canonicalCandidate) ? canonicalCandidate : null;
  } catch {
    return null;
  }
}

function resolveFileWithinDirectory(root: string, filePath: string): string | null {
  try {
    const canonicalRoot = fs.realpathSync(root);
    const canonicalFile = fs.realpathSync(filePath);
    return isWithinDirectory(canonicalRoot, canonicalFile) ? canonicalFile : null;
  } catch {
    return null;
  }
}

function readMarkdownFile(
  filePath: string,
  maxBytes = 128 * 1024,
  allowedRoot?: string,
): string | null {
  try {
    const resolvedFile = allowedRoot ? resolveFileWithinDirectory(allowedRoot, filePath) : filePath;
    if (!resolvedFile) return null;
    const stat = fs.statSync(resolvedFile);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(resolvedFile, "utf-8").replace(/\r\n/g, "\n").trim();
  } catch {
    return null;
  }
}

function listMarkdownFiles(rootDir: string, matcher: (fileName: string) => boolean): string[] {
  const files: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, depth + 1);
      } else if (entry.isFile() && matcher(entry.name)) {
        files.push(fullPath);
      }
    }
  };
  visit(rootDir, 0);
  return files.sort((a, b) => a.localeCompare(b));
}

function parseMarkdownSummaryFromContent(
  filePath: string,
  content: string,
): { name: string; description: string } {
  const fallbackName = path.basename(filePath).replace(/\.(agent\.)?md$/i, "");
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
    return {
      name: nameMatch ? stripYamlQuotes(nameMatch[1].trim()) : fallbackName,
      description: descMatch ? stripYamlQuotes(descMatch[1].trim()) : "",
    };
  }
  const headingMatch = content.match(/^#\s+(.+)$/m);
  return { name: headingMatch ? headingMatch[1].trim() : fallbackName, description: "" };
}

function parseMarkdownSummary(
  filePath: string,
  allowedRoot: string,
): { name: string; description: string } | null {
  const content = readMarkdownFile(filePath, 32 * 1024, allowedRoot);
  return content === null ? null : parseMarkdownSummaryFromContent(filePath, content);
}

function stripMarkdownFrontmatter(content: string): string {
  const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return (frontmatterMatch ? frontmatterMatch[1] : content).trim();
}

function normalizeRepositoryRoot(repoRoot?: string): string | null {
  if (!repoRoot) return null;
  try {
    return fs.realpathSync(path.resolve(repoRoot));
  } catch {
    return null;
  }
}

function resolveConventionDirectory(root: string, convention: RepositoryConvention): string | null {
  return resolveDirectoryWithin(root, path.join(root, convention.directory));
}

function resolveGitHubDirectory(repoRoot?: string): { root: string; githubDir: string } | null {
  const root = normalizeRepositoryRoot(repoRoot);
  if (!root) return null;
  const githubDir = resolveDirectoryWithin(root, path.join(root, ".github"));
  return githubDir ? { root, githubDir } : null;
}

function parseRepositoryAgentFile(
  root: string,
  agentsDir: string,
  filePath: string,
  source: RepositoryCustomizationSource = "copilot",
): RepositoryAgentDefinition | null {
  const content = readMarkdownFile(filePath, 256 * 1024, agentsDir);
  if (!content) return null;
  const summary = parseMarkdownSummaryFromContent(filePath, content);
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const modelMatch = frontmatterMatch?.[1]?.match(/^model:\s*(.+)$/m);
  const relativePath = path.relative(root, filePath);
  return {
    path: relativePath,
    name: summary.name,
    description: summary.description,
    instructions: stripMarkdownFrontmatter(content),
    source,
    ...(modelMatch ? { model: stripYamlQuotes(modelMatch[1].trim()) } : {}),
    identity: createRepositoryAgentIdentity({
      path: relativePath,
      name: summary.name,
      canonicalContent: content,
    }),
  };
}

export function loadRepositoryAgents(repoRoot?: string): RepositoryAgentDefinition[] {
  const root = normalizeRepositoryRoot(repoRoot);
  if (!root) return [];
  return REPOSITORY_CONVENTIONS.flatMap((convention) => {
    const conventionDir = resolveConventionDirectory(root, convention);
    if (!conventionDir) return [];
    const agentsDir = resolveDirectoryWithin(
      conventionDir,
      path.join(conventionDir, convention.agentDirectory),
    );
    if (!agentsDir) return [];
    return listMarkdownFiles(agentsDir, (name) => name.endsWith(".md"))
      .map((filePath) => parseRepositoryAgentFile(root, agentsDir, filePath, convention.source))
      .filter((agent): agent is RepositoryAgentDefinition => agent !== null);
  });
}

function loadCopilotRepositoryAgents(repoRoot?: string): RepositoryAgentDefinition[] {
  const resolved = resolveGitHubDirectory(repoRoot);
  if (!resolved) return [];
  const agentsDir = resolveDirectoryWithin(
    resolved.githubDir,
    path.join(resolved.githubDir, "agents"),
  );
  if (!agentsDir) return [];
  return listMarkdownFiles(agentsDir, (name) => name.endsWith(".md"))
    .map((filePath) => parseRepositoryAgentFile(resolved.root, agentsDir, filePath, "copilot"))
    .filter((agent): agent is RepositoryAgentDefinition => agent !== null)
    .map(({ source: _source, ...agent }) => agent);
}

/** Legacy Copilot-only reader retained for compatibility callers and tests. */
export function loadGitHubRepositoryAgents(repoRoot?: string): RepositoryAgentDefinition[] {
  return loadCopilotRepositoryAgents(repoRoot);
}

export function getRepositoryAgentByPath(
  repoRoot: string | undefined,
  relativeAgentPath: string,
): RepositoryAgentDefinition | null {
  const root = normalizeRepositoryRoot(repoRoot);
  if (!root) return null;
  const normalizedRelativePath = relativeAgentPath.replace(/[\\/]+/g, path.sep);
  const agentPath = path.resolve(root, normalizedRelativePath);
  for (const convention of REPOSITORY_CONVENTIONS) {
    const conventionDir = resolveConventionDirectory(root, convention);
    if (!conventionDir) continue;
    const agentsDir = resolveDirectoryWithin(
      conventionDir,
      path.join(conventionDir, convention.agentDirectory),
    );
    if (!agentsDir || !isWithinDirectory(agentsDir, agentPath) || !fs.existsSync(agentPath)) {
      continue;
    }
    return parseRepositoryAgentFile(root, agentsDir, agentPath, convention.source);
  }
  return null;
}

function readRepositoryInstruction(
  root: string,
  filePath: string,
  allowedRoot: string,
): RepositoryInstruction | null {
  const content = readMarkdownFile(filePath, 128 * 1024, allowedRoot);
  if (!content) return null;
  const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1];
  const applicabilityField = frontmatter.match(/^(?:globs|paths|applyTo):\s*(.*)$/m);
  const inlinePatterns = applicabilityField?.[1]?.trim() ?? "";
  const patterns = inlinePatterns
    ? inlinePatterns
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((value) => stripYamlQuotes(value.trim()))
        .filter(Boolean)
    : [];
  if (applicabilityField && patterns.length === 0) {
    const fieldOffset = frontmatter.indexOf(applicabilityField[0]) + applicabilityField[0].length;
    const remainder = frontmatter.slice(fieldOffset);
    for (const match of remainder.matchAll(/^\s*-\s*(.+)$/gm)) {
      const value = stripYamlQuotes(match[1].trim());
      if (value) patterns.push(value);
    }
  }
  const nestedInstruction =
    (path.basename(filePath) === "AGENTS.md" || path.basename(filePath) === "CLAUDE.md") &&
    path.dirname(relativePath) !== "." &&
    relativePath !== ".claude/CLAUDE.md";
  if (nestedInstruction && patterns.length === 0) {
    patterns.push(`${path.dirname(relativePath).replace(/\\/g, "/")}/**`);
  }
  const cursorRule = relativePath.startsWith(".cursor/rules/");
  const explicitAlways = /^alwaysApply:\s*true\s*$/m.test(frontmatter);
  const explicitDynamic = /^alwaysApply:\s*false\s*$/m.test(frontmatter);
  const alwaysApply = explicitAlways
    ? true
    : explicitDynamic || patterns.length > 0 || nestedInstruction
      ? false
      : !cursorRule;
  const source: RepositoryCustomizationSource | "shared" = relativePath.startsWith(".github/")
    ? "copilot"
    : relativePath.startsWith(".cursor/")
      ? "cursor"
      : relativePath.startsWith(".claude/") || path.basename(filePath) === "CLAUDE.md"
        ? "claude"
        : "shared";
  return {
    path: path.relative(root, filePath),
    content,
    source,
    alwaysApply,
    ...(patterns.length > 0 ? { appliesTo: patterns } : {}),
    ...(description ? { description: stripYamlQuotes(description.trim()) } : {}),
  };
}

function loadRuleDirectory(
  root: string,
  directory: string,
  matcher: (name: string) => boolean,
): RepositoryInstruction[] {
  const resolvedDirectory = resolveDirectoryWithin(root, directory);
  if (!resolvedDirectory) return [];
  return listMarkdownFiles(resolvedDirectory, matcher)
    .map((filePath) => readRepositoryInstruction(root, filePath, resolvedDirectory))
    .filter((item): item is RepositoryInstruction => item !== null);
}

function loadHierarchicalInstructionFiles(root: string): RepositoryInstruction[] {
  const instructions: RepositoryInstruction[] = [];
  const ignoredDirectories = new Set([".git", "node_modules", "dist", "build", "coverage"]);
  const visit = (directory: string, depth: number) => {
    if (depth > 6 || instructions.length >= 64) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (instructions.length >= 64) break;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !ignoredDirectories.has(entry.name)) {
          visit(candidate, depth + 1);
        }
        continue;
      }
      if (!entry.isFile() || (entry.name !== "AGENTS.md" && entry.name !== "CLAUDE.md")) continue;
      const item = readRepositoryInstruction(root, candidate, root);
      if (item) instructions.push(item);
    }
  };
  visit(root, 0);
  return instructions;
}

export function loadRepositoryInstructions(repoRoot?: string): RepositoryInstruction[] {
  const root = normalizeRepositoryRoot(repoRoot);
  if (!root) return [];
  const instructions = loadCopilotRepositoryInstructions(root);
  instructions.push(...loadHierarchicalInstructionFiles(root));
  for (const relativePath of [path.join(".claude", "CLAUDE.md")]) {
    const item = readRepositoryInstruction(root, path.join(root, relativePath), root);
    if (item) instructions.push(item);
  }
  instructions.push(
    ...loadRuleDirectory(root, path.join(root, ".cursor", "rules"), (name) =>
      name.endsWith(".mdc"),
    ),
    ...loadRuleDirectory(root, path.join(root, ".claude", "rules"), (name) => name.endsWith(".md")),
  );
  return instructions.filter(
    (item, index, all) => all.findIndex((candidate) => candidate.path === item.path) === index,
  );
}

function parseRepositoryCommandFile(
  root: string,
  commandsDir: string,
  filePath: string,
  source: RepositoryCustomizationSource,
): RepositoryCommandDefinition | null {
  const content = readMarkdownFile(filePath, 128 * 1024, commandsDir);
  if (!content) return null;
  const summary = parseMarkdownSummaryFromContent(filePath, content);
  return {
    path: path.relative(root, filePath),
    name: summary.name,
    description: summary.description,
    source,
    instructions: stripMarkdownFrontmatter(content),
  };
}

export function loadRepositoryCommands(repoRoot?: string): RepositoryCommandDefinition[] {
  const root = normalizeRepositoryRoot(repoRoot);
  if (!root) return [];
  return REPOSITORY_CONVENTIONS.flatMap((convention) => {
    if (!convention.commandDirectory) return [];
    const conventionDir = resolveConventionDirectory(root, convention);
    if (!conventionDir) return [];
    const commandsDir = resolveDirectoryWithin(
      conventionDir,
      path.join(conventionDir, convention.commandDirectory),
    );
    if (!commandsDir) return [];
    return listMarkdownFiles(commandsDir, (name) =>
      convention.source === "copilot" ? name.endsWith(".prompt.md") : name.endsWith(".md"),
    )
      .map((filePath) => parseRepositoryCommandFile(root, commandsDir, filePath, convention.source))
      .filter((command): command is RepositoryCommandDefinition => command !== null);
  });
}

/** Codex's app-server loads the repository-root AGENTS.md itself (unless
 *  `project_doc_max_bytes` is 0, which Marshal sets exactly when it drops the
 *  repository context), so forwarding it again would inject the file twice. */
function isNativelyLoadedRootAgentsFile(
  item: RepositoryInstruction,
  runtimeId: string | undefined,
): boolean {
  return runtimeId === "codex" && item.source === "shared" && item.path === "AGENTS.md";
}

const LEAN_INLINE_ALWAYS_MAX_CHARS = 4000;
const LEAN_MIRROR_CONTAINMENT = 0.85;
const LEAN_INDEX_PURPOSE_MAX_CHARS = 140;

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function wordShingles(content: string): Set<string> {
  const words = stripFrontmatter(content)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const shingles = new Set<string>();
  for (let index = 0; index + 4 <= words.length; index++) {
    shingles.add(words.slice(index, index + 4).join(" "));
  }
  return shingles;
}

/** The native instruction that already contains (almost) all of this body, if any. */
function findNativeMirror(
  item: RepositoryInstruction,
  nativeShingles: ReadonlyArray<{ path: string; shingles: Set<string> }>,
): string | undefined {
  const own = wordShingles(item.content);
  if (own.size === 0) return undefined;
  for (const native of nativeShingles) {
    let contained = 0;
    for (const shingle of own) if (native.shingles.has(shingle)) contained++;
    if (contained / own.size >= LEAN_MIRROR_CONTAINMENT) return native.path;
  }
  return undefined;
}

function instructionPurpose(item: RepositoryInstruction): string {
  const text =
    item.description ??
    stripFrontmatter(item.content)
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0) ??
    "";
  return text.length > LEAN_INDEX_PURPOSE_MAX_CHARS
    ? `${text.slice(0, LEAN_INDEX_PURPOSE_MAX_CHARS - 1)}…`
    : text;
}

function formatLeanIndexEntry(item: RepositoryInstruction, note?: string): string {
  const purpose = instructionPurpose(item);
  const size = `${Math.max(1, Math.round(item.content.length / 1024))} KB`;
  return `- ${item.path.replace(/\\/g, "/")} (${size})${purpose ? `: ${purpose}` : ""}${note ? ` — ${note}` : ""}`;
}

export function getRepositoryCustomizationsForSystemPrompt(
  repoRoot?: string,
  runtimeId?: string,
  options?: { lean?: boolean },
): string {
  const instructions = loadRepositoryInstructions(repoRoot);
  const agents = loadRepositoryAgents(repoRoot);
  const commands = loadRepositoryCommands(repoRoot);
  const hooks = loadGitHubRepositoryArtifacts(repoRoot, "hooks");
  if (
    instructions.length === 0 &&
    agents.length === 0 &&
    commands.length === 0 &&
    hooks.length === 0
  ) {
    return "";
  }
  const nativeSources =
    runtimeId === "cursor"
      ? new Set<RepositoryInstruction["source"]>(["cursor", "shared"])
      : runtimeId === "claude"
        ? new Set<RepositoryInstruction["source"]>(["claude"])
        : new Set<RepositoryInstruction["source"]>();
  const forwardedInstructions = instructions.filter(
    (item) => !nativeSources.has(item.source) && !isNativelyLoadedRootAgentsFile(item, runtimeId),
  );
  if (
    forwardedInstructions.length === 0 &&
    agents.length === 0 &&
    commands.length === 0 &&
    hooks.length === 0
  ) {
    return "";
  }
  const leanClaude = options?.lean === true && runtimeId === "claude";
  const allAlwaysInstructions = forwardedInstructions.filter((item) => item.alwaysApply !== false);
  let scopedInstructions = forwardedInstructions.filter((item) => item.alwaysApply === false);
  const nativeShingles = leanClaude
    ? instructions
        .filter((item) => nativeSources.has(item.source))
        .map((item) => ({
          path: item.path.replace(/\\/g, "/"),
          shingles: wordShingles(item.content),
        }))
    : [];
  const alwaysInstructions: RepositoryInstruction[] = [];
  const indexedAlways: string[] = [];
  const mirroredAlways: string[] = [];
  for (const item of allAlwaysInstructions) {
    if (!leanClaude) {
      alwaysInstructions.push(item);
      continue;
    }
    const mirror = findNativeMirror(item, nativeShingles);
    if (mirror) {
      mirroredAlways.push(formatLeanIndexEntry(item, `already loaded natively via ${mirror}`));
    } else if (item.content.length <= LEAN_INLINE_ALWAYS_MAX_CHARS) {
      alwaysInstructions.push(item);
    } else {
      indexedAlways.push(formatLeanIndexEntry(item));
    }
  }
  const redundantScoped = new Map<string, string[]>();
  if (leanClaude) {
    const providedShingles = [
      ...nativeShingles,
      ...allAlwaysInstructions.map((item) => ({
        path: item.path.replace(/\\/g, "/"),
        shingles: wordShingles(item.content),
      })),
    ];
    scopedInstructions = scopedInstructions.filter((item) => {
      const mirror = findNativeMirror(item, providedShingles);
      if (!mirror) return true;
      redundantScoped.set(mirror, [
        ...(redundantScoped.get(mirror) ?? []),
        item.path.replace(/\\/g, "/"),
      ]);
      return false;
    });
  }
  const redundantScopedLines = [...redundantScoped].map(
    ([source, paths]) =>
      `- ${paths.length} scoped file${paths.length === 1 ? "" : "s"} omitted as duplicate(s) of ${source} (e.g. ${paths[0]})`,
  );
  const blocks = alwaysInstructions.map(
    (item) => `### ${item.path.replace(/\\/g, "/")}\n\n${item.content}`,
  );
  const leanIndexBlock =
    indexedAlways.length + mirroredAlways.length > 0
      ? `\n\n### Always-Apply Repository Rules (read on demand)\nThese rule bodies are not loaded by this runtime and are not inlined here. They apply to all work in this repository: read the files that match your task before you start (the purpose is the file's own description).${
          indexedAlways.length ? `\n${indexedAlways.join("\n")}` : ""
        }${
          mirroredAlways.length
            ? `\nNo need to read (their content is already in your natively loaded rules):\n${mirroredAlways.join("\n")}`
            : ""
        }`
      : "";
  const scopedInstructionBlock =
    scopedInstructions.length || redundantScopedLines.length
      ? `\n\n### Scoped Repository Rules\nThese rule bodies remain in the repository. Read the matching file before working in its scope:\n${[
          ...scopedInstructions.map(
            (item) =>
              `- ${item.path.replace(/\\/g, "/")}${item.description ? `: ${item.description}` : ""}${item.appliesTo?.length ? ` (applies to ${item.appliesTo.join(", ")})` : " (apply intelligently when relevant)"}`,
          ),
          ...redundantScopedLines,
        ].join("\n")}`
      : "";
  const agentBlock = agents.length
    ? `\n\n### Available Repository Agents\n${agents
        .map(
          (item) =>
            `- ${item.name}${item.description ? `: ${item.description}` : ""} [${item.source ?? "repository"}] (${item.path.replace(/\\/g, "/")})`,
        )
        .join("\n")}`
    : "";
  const commandBlock = commands.length
    ? `\n\n### Available Repository Commands\n${commands
        .map(
          (item) =>
            `- /${item.name}${item.description ? `: ${item.description}` : ""} [${item.source}] (${item.path.replace(/\\/g, "/")})`,
        )
        .join("\n")}`
    : "";
  const hookBlock = hooks.length
    ? `\n\n### Available Repository Hooks\n${hooks
        .map(
          (item) =>
            `- ${item.name}${item.description ? `: ${item.description}` : ""} (${item.path.replace(/\\/g, "/")})`,
        )
        .join("\n")}`
    : "";
  return `

## Repository Instructions
The following user-authored repository customizations were discovered across supported agent conventions. More specific workspace instructions override general ones when they conflict:

${blocks.join("\n\n")}${leanIndexBlock}${scopedInstructionBlock}${agentBlock}${commandBlock}${hookBlock}
`;
}

export function getRepositorySkillProviderRoots(
  repoRoot?: string,
  runtimeId?: string,
): SkillProviderRoot[] {
  const root = normalizeRepositoryRoot(repoRoot);
  if (!root) return [];
  const roots: SkillProviderRoot[] = [];
  for (const convention of REPOSITORY_CONVENTIONS) {
    const conventionDir = resolveConventionDirectory(root, convention);
    if (!conventionDir) continue;
    const skillsDir = resolveDirectoryWithin(
      conventionDir,
      path.join(conventionDir, convention.skillDirectory),
    );
    if (skillsDir && !(runtimeId === "claude" && convention.source === "claude")) {
      roots.push({
        id: `${convention.source}-workspace`,
        directory: skillsDir,
        idPrefix: `repo-${convention.source}`,
        scope: "local",
      });
    }
    if (convention.commandDirectory) {
      const commandsDir = resolveDirectoryWithin(
        conventionDir,
        path.join(conventionDir, convention.commandDirectory),
      );
      if (commandsDir) {
        roots.push({
          id: `${convention.source}-commands`,
          directory: commandsDir,
          idPrefix: `repo-${convention.source}-command`,
          scope: "local",
          format: "command-files",
          fileSuffix: convention.source === "copilot" ? ".prompt.md" : ".md",
        });
      }
    }
  }
  const portableSkillsDir = resolveDirectoryWithin(root, path.join(root, ".agents", "skills"));
  if (portableSkillsDir) {
    roots.push({
      id: "agents-workspace",
      directory: portableSkillsDir,
      idPrefix: "repo-agents",
      scope: "local",
    });
  }
  return roots;
}

function getCopilotRepositoryAgentByPath(
  repoRoot: string | undefined,
  relativeAgentPath: string,
): RepositoryAgentDefinition | null {
  const resolved = resolveGitHubDirectory(repoRoot);
  if (!resolved) return null;
  const agentsDir = resolveDirectoryWithin(
    resolved.githubDir,
    path.join(resolved.githubDir, "agents"),
  );
  if (!agentsDir) return null;
  const normalizedRelativePath = relativeAgentPath.replace(/[\\/]+/g, path.sep);
  const agentPath = path.resolve(resolved.root, normalizedRelativePath);
  if (!isWithinDirectory(agentsDir, agentPath) || !fs.existsSync(agentPath)) return null;
  const parsed = parseRepositoryAgentFile(resolved.root, agentsDir, agentPath);
  if (!parsed) return null;
  const { source: _source, ...agent } = parsed;
  return agent;
}

/** Legacy Copilot-only lookup retained for compatibility callers and tests. */
export function getGitHubRepositoryAgentByPath(
  repoRoot: string | undefined,
  relativeAgentPath: string,
): RepositoryAgentDefinition | null {
  return getCopilotRepositoryAgentByPath(repoRoot, relativeAgentPath);
}

function loadCopilotRepositoryInstructions(repoRoot?: string): RepositoryInstruction[] {
  const resolved = resolveGitHubDirectory(repoRoot);
  if (!resolved) return [];
  const instructions: RepositoryInstruction[] = [];
  const rootInstruction = path.join(resolved.githubDir, "copilot-instructions.md");
  const rootItem = readRepositoryInstruction(resolved.root, rootInstruction, resolved.githubDir);
  if (rootItem) instructions.push(rootItem);
  const instructionsDir = resolveDirectoryWithin(
    resolved.githubDir,
    path.join(resolved.githubDir, "instructions"),
  );
  if (instructionsDir) {
    for (const filePath of listMarkdownFiles(instructionsDir, (name) =>
      name.endsWith(".instructions.md"),
    )) {
      const item = readRepositoryInstruction(resolved.root, filePath, resolved.githubDir);
      if (item) instructions.push(item);
    }
  }
  return instructions;
}

/** Legacy Copilot-only instruction reader retained for compatibility callers and tests. */
export function loadGitHubRepositoryInstructions(repoRoot?: string): RepositoryInstruction[] {
  return loadCopilotRepositoryInstructions(repoRoot).map(({ path: itemPath, content }) => ({
    path: itemPath,
    content,
  }));
}

export function loadGitHubRepositoryArtifacts(
  repoRoot: string | undefined,
  directoryName: "agents" | "hooks",
): RepositoryArtifact[] {
  const resolved = resolveGitHubDirectory(repoRoot);
  if (!resolved) return [];
  const artifactsDir = resolveDirectoryWithin(
    resolved.githubDir,
    path.join(resolved.githubDir, directoryName),
  );
  if (!artifactsDir) return [];
  const artifacts: RepositoryArtifact[] = [];
  for (const filePath of listMarkdownFiles(artifactsDir, (name) => name.endsWith(".md"))) {
    const summary = parseMarkdownSummary(filePath, artifactsDir);
    if (!summary) continue;
    artifacts.push({
      path: path.relative(resolved.root, filePath),
      name: summary.name,
      description: summary.description,
    });
  }
  return artifacts;
}

export function getGitHubRepositoryCustomizationsForSystemPrompt(repoRoot?: string): string {
  const instructions = loadCopilotRepositoryInstructions(repoRoot);
  const agents = loadGitHubRepositoryArtifacts(repoRoot, "agents");
  const hooks = loadGitHubRepositoryArtifacts(repoRoot, "hooks");
  if (instructions.length === 0 && agents.length === 0 && hooks.length === 0) return "";
  const blocks = instructions.map(
    (item) => `### ${item.path.replace(/\\/g, "/")}\n\n${item.content}`,
  );
  const agentBlock = agents.length
    ? `\n\n### Available Repository Agents\n${agents
        .map(
          (item) =>
            `- ${item.name}${item.description ? `: ${item.description}` : ""} (${item.path.replace(/\\/g, "/")})`,
        )
        .join("\n")}`
    : "";
  const hookBlock = hooks.length
    ? `\n\n### Available Repository Hooks\n${hooks
        .map(
          (item) =>
            `- ${item.name}${item.description ? `: ${item.description}` : ""} (${item.path.replace(/\\/g, "/")})`,
        )
        .join("\n")}`
    : "";
  return `

## Repository Instructions
The following instructions were loaded from the active repository's .github directory. They are repo-local user-authored instructions for this workspace:

${blocks.join("\n\n")}${agentBlock}${hookBlock}
`;
}

export function getGitHubSkillProviderRoots(repoRoot?: string): SkillProviderRoot[] {
  const resolved = resolveGitHubDirectory(repoRoot);
  if (!resolved) return [];
  const skillsDir = resolveDirectoryWithin(
    resolved.githubDir,
    path.join(resolved.githubDir, "skills"),
  );
  return skillsDir
    ? [
        {
          id: "github-workspace",
          directory: skillsDir,
          idPrefix: "repo",
          scope: "local",
        },
      ]
    : [];
}
