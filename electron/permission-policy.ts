import type {
  ReviewerValidationAuthorizationResult,
  ReviewerValidationPermissionRequest,
} from "../common/goal-infrastructure-contract";
import type { PermissionAction } from "../common/marshal-constants";
import type {
  PermissionsConfig,
  ReviewerSessionPermissionScope,
  SessionPermissionMode,
} from "../common/marshal-ipc-contract";
import {
  PERMISSION_KIND_TUPLE,
  REVIEWER_SESSION_CAPABILITIES,
} from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import { CONFIG_KEY_TO_DISPLAY_NAME } from "../common/marshal-permission-servers";
import { toMcpServerKey } from "../common/mcp-server-key-normalization";
import type { AuditDecisionSource, AuditLogger } from "./audit-log";
import type {
  IPermissionPolicy,
  IReviewerValidationAuthorizationPort,
  IReviewerValidationExecutorPort,
} from "./backend/ports";
import type { ApprovalDecision, ApprovalRequest } from "./backend/types";
import { migrateToolPermissionKeys } from "./migrate-tool-permission-keys";
import { migrateToolsFromAllow } from "./migrate-tools-from-allow";
import { grantFolderForPath, isPathWithinDir } from "./permission-path-scope";
import { applyGuardrails } from "./permission-pattern-guardrails";
import {
  extractPattern,
  extractPatterns,
  getPatternKey,
  isUnsafeShellSyntax,
  splitShellSegments,
  tokenize,
  VAR_ASSIGN_PREFIX_RE,
} from "./permission-patterns";
import {
  POLICY_PRE_HOOK_RULES,
  TENANT_DISABLED_SERVER,
  type PolicyContext,
  type PreHookDeny,
} from "./permission-policy-checks";
import { FOLDER_GRANT_RULE } from "./policy-rules/folder-grant";
import { POLICY_RULES } from "./policy-rules/index";
import { SERVER_DISABLED_RULE } from "./policy-rules/marshal-server-disabled";
import { TENANT_DENY_RULE } from "./policy-rules/marshal-tenant-deny";
import { TENANT_FORCE_PROMPT_RULE } from "./policy-rules/marshal-tenant-force-prompt";
import { KIND_TO_SERVER_FALLBACK } from "./policy-rules/permission-kind-mappings";
import { SENSITIVE_PATH_GATE_RULE } from "./policy-rules/sensitive-path-access-gate-rule";
import type {
  PolicyContext as RulePolicyContext,
  PolicyRule as EvaluationPolicyRule,
  RuleResult,
} from "./policy-rules/types";
import { hasRemoteAuthVector } from "./remote-auth-permission-guard";
import { checkSensitivePath, type SensitivePathHit } from "./sensitive-path-permission-guard";
import type { SettingsManager } from "./settings-manager";
import {
  getShellMode,
  isPureQuotedLiteral,
  POWERSHELL_INERT_TOKENS,
  type ShellMode,
} from "./shell-syntax-permission-utils";
import type { TenantPolicyProvider } from "./tenant-policy";

const FALLBACK_PERMISSIONS: PermissionsConfig = {
  autoApproveReadOnly: false,
  allow: [],
  tools: {},
  servers: {},
};

const log = createLogger("PermissionPolicy");

const REVIEWER_DENY_REASON =
  "Blocked by read-only reviewer policy. Reviewer sessions may inspect repository state, but " +
  "cannot mutate state, send data, control other sessions, or invoke unclassified tools.";

export type PermissionDecision = "approve" | "deny" | "prompt";

/** Result of {@link PermissionPolicy.evaluateDetailed}: the decision plus, for
 *  hard `deny` outcomes, a human-readable reason the CopilotBackend surfaces to
 *  the model (via a `reject`+feedback SDK result) instead of the generic
 *  "could not request permission" message. `denyReason` is only set when
 *  `decision === "deny"`. */
export interface PolicyEvaluation {
  decision: PermissionDecision;
  denyReason?: string;
}

/**
 * Maps a denying policy rule to an actionable, model-facing reason.
 *
 * Wording is deliberately defensive: it states that the block is automatic
 * (no human is being asked), tells the model not to retry or work around the
 * block with an equivalent command/tool, and steers it toward stopping and
 * asking the user. This replaces the misleading "could not request permission
 * from user" string for genuine policy denials so the agent adapts instead of
 * looping on the same wall.
 */
export function denyReasonForRule(ruleId: string): string {
  switch (ruleId) {
    case "shell-deny-pattern":
      return (
        "Blocked by Marshal's dangerous-command security policy (automatic — " +
        "no human is being asked, and this cannot be unblocked by requesting approval). " +
        "The command matched a destructive or unsafe shell pattern. Do not retry this command " +
        "and do not attempt the same effect through a different command, tool, or workaround. " +
        "If this operation is genuinely required, stop and ask the user to run it themselves " +
        "or to change their permission settings."
      );
    case "tenant-deny":
      return (
        "Blocked by your organization's tenant security policy. This cannot be overridden here. " +
        "Do not retry. If you believe this capability is required, stop and ask the user or their " +
        "administrator."
      );
    case "server-disabled":
      return (
        "Blocked because the required tool or server is disabled in settings. Do not retry. " +
        "Ask the user to enable it only if it is genuinely needed."
      );
    case "folder-grant":
      return (
        "Blocked because this path is outside the current workspace and your organization's tenant " +
        "policy restricts work to the workspace. A per-folder grant will not override this. Operate " +
        "within the workspace instead, or stop and ask the user or their administrator to change the " +
        "workspace restriction if this access is genuinely required."
      );
    case "background-deny":
      return (
        "Blocked because this background/unattended session is not allowed to run actions that " +
        "need approval and no one is available to approve. Do not retry. Defer this action until " +
        "the user is available."
      );
    case "remote-auth-vector":
      return (
        "Blocked by Marshal security policy because the command resembles a credential or " +
        "remote-auth exfiltration pattern. Do not retry or attempt a variation. If this is " +
        "legitimate, stop and ask the user to run it themselves."
      );
    case "read-only-reviewer":
      return REVIEWER_DENY_REASON;
    default:
      return (
        "Blocked by Marshal security policy (automatic — not a user decision). Do not retry " +
        "an equivalent action through another command or workaround. If it is genuinely required, " +
        "stop and ask the user to perform it or adjust their settings."
      );
  }
}

/** Outcome of extracting an approval rule from a permission request.
 *  Either shell allow patterns, a structured-tool key, a non-tool pattern
 *  key (rare), or null when the request can't be expressed as a rule
 *  (empty command, bare-wildcard, etc.). */
type ApprovalRule = { kind: "allow"; patterns: string[] } | { kind: "tool"; key: string } | null;

// All permission kinds — single source of truth in marshal-ipc-contract.ts.
export const ALL_PERMISSION_KINDS = PERMISSION_KIND_TUPLE;

export {
  KIND_TO_SERVER_FALLBACK,
  KIND_TO_MCP_TOOLS,
} from "./policy-rules/permission-kind-mappings";

// Commands that only read/inspect — safe to auto-approve
const READ_ONLY_PREFIXES = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "locate",
  "which",
  "where",
  "where.exe",
  "whereis",
  "type",
  "grep",
  "rg",
  "ag",
  "ack",
  "echo",
  "printf",
  "date",
  "cal",
  "uptime",
  "whoami",
  "id",
  "hostname",
  "pwd",
  "ps",
  "top -l",
  "pgrep",
  "git blame",
  "git stash list",
  "git worktree list",
  "git submodule status",
  "git describe",
  "git shortlog",
  "git rev-parse",
  "git config --list",
  "git config --get",
  "npm list",
  "npm ls",
  "pnpm list",
  "pnpm why",
  "yarn list",
  "yarn info",
  "docker ps",
  "docker images",
  "docker logs",
  "docker inspect",
  "kubectl get",
  "kubectl describe",
  "kubectl logs",
  "gh pr view",
  "gh pr list",
  "gh issue view",
  "gh issue list",
  "gh repo view",
  "jq",
  "xmllint",
  "json_pp",
  "diff",
  "comm",
  "uniq",
  "cut",
  "tr",
  "fold",
  "column",
  "md5",
  "shasum",
  "sha256sum",
  "test ",
  "[ ",
  "basename",
  "dirname",
  "readlink",
  "tree",
  "tac",
  "nl",
  "tldr",
  "man",
];

// PowerShell read-only cmdlets — matched case-insensitively against the first token
// of a segment. Verbs that execute arbitrary script blocks (Where-Object,
// ForEach-Object) or mutate state (Set-*, Remove-*, Stop-*, Start-*, Clear-*,
// New-*, Invoke-*) are intentionally excluded. Read-Host is excluded (blocks
// on stdin). Get-WmiObject is excluded — deprecated and returned WMI objects
// expose mutating methods like Win32_Process.Create.
const READ_ONLY_POWERSHELL_CMDLETS = new Set(
  [
    "Get-Content",
    "Get-ChildItem",
    "Get-Process",
    "Get-Item",
    "Get-Location",
    "Get-Command",
    "Get-Help",
    "Get-Module",
    "Get-Service",
    "Get-Member",
    "Get-Date",
    "Get-Variable",
    "Get-History",
    "Get-Host",
    "Get-EventLog",
    "Get-CimInstance",
    "Get-NetAdapter",
    "Get-NetIPAddress",
    "Select-String",
    "Select-Object",
    "Measure-Object",
    "Compare-Object",
    "Test-Path",
    "ConvertFrom-Json",
    "ConvertTo-Json",
    "Format-Table",
    "Format-List",
    "Format-Wide",
    "Out-String",
    "Out-Host",
    // Pipeline utilities with no filesystem side effects. Tee-Object is
    // intentionally excluded — it writes files.
    "Write-Host",
    "Write-Output",
    "Sort-Object",
    "Group-Object",
    "Set-Location",
    // POSIX navigation aliases — shell state only, no filesystem writes.
    // Checked via exact first-token match (not prefix) so commands like
    // `cdromutility` don't accidentally qualify as readonly.
    "cd",
    "pushd",
    "popd",
  ].map((s) => s.toLowerCase()),
);

// Detect `az ... list` / `az ... show` as read-only. Scans only positional
// tokens (not flags) so "az vm list --resource-group foo" qualifies. Conservative:
// requires az as first token AND list|show to appear somewhere in the positional
// subcommand chain AND no other word after list/show in positional slots (no
// "az repos list create" false positives from a hypothetical trailing verb).
function isReadOnlyAzCommand(segment: string): boolean {
  const tokens = tokenize(segment);
  if (tokens[0]?.toLowerCase() !== "az") return false;
  const positional: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      // Skip flag value if the next token is not itself a flag and is a positional-looking value.
      // Heuristic: az flags generally take a value in the next slot. Safest: skip one token
      // after each flag unless that token also starts with "-".
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        i += 1;
      }
      continue;
    }
    positional.push(t.toLowerCase());
  }
  // Positional shape must end with list|show (no verb after it).
  return positional.length >= 2 && (positional.at(-1) === "list" || positional.at(-1) === "show");
}

function gitFlagName(token: string): string {
  const equals = token.indexOf("=");
  return (equals === -1 ? token : token.slice(0, equals)).toLowerCase();
}

function hasMutatingShortGitFlag(token: string, mutatingFlags: Set<string>): boolean {
  const lower = token.toLowerCase();
  if (!lower.startsWith("-") || lower.startsWith("--")) return false;
  return [...mutatingFlags].some((flag) => !flag.startsWith("--") && lower.startsWith(flag));
}

function hasOnlyKnownShortGitFlags(token: string, knownFlags: Set<string>): boolean {
  const lower = token.toLowerCase();
  if (!lower.startsWith("-") || lower.startsWith("--") || lower.length < 2) return false;
  for (let i = 1; i < lower.length; i++) {
    if (!knownFlags.has(`-${lower[i]}`)) return false;
  }
  return true;
}

// Flags that cause git to emit full diff output, invoking diff.external in .git/config.
const GIT_DIFF_OUTPUT_FLAGS = new Set(["-p", "--patch", "-u"]);

const MUTATING_GIT_BRANCH_FLAGS = new Set([
  "-c",
  "-d",
  "-f",
  "-m",
  "-u",
  "--copy",
  "--create-reflog",
  "--delete",
  "--edit-description",
  "--force",
  "--move",
  "--recurse-submodules",
  "--set-upstream-to",
  "--unset-upstream",
]);

const READ_ONLY_GIT_BRANCH_SHORT_FLAGS = new Set(["-a", "-l", "-r", "-v"]);

const READ_ONLY_GIT_BRANCH_BOOLEAN_FLAGS = new Set([
  "-a",
  "-r",
  "-v",
  "-vv",
  "--all",
  "--ignore-case",
  "--no-abbrev",
  "--no-color",
  "--no-column",
  "--omit-empty",
  "--remotes",
  "--show-current",
  "--verbose",
]);

const READ_ONLY_GIT_BRANCH_VALUE_FLAGS = new Set([
  "-l",
  "--abbrev",
  "--color",
  "--column",
  "--contains",
  "--format",
  "--list",
  "--merged",
  "--no-contains",
  "--no-merged",
  "--points-at",
  "--sort",
]);

function isReadOnlyGitBranch(tokens: string[]): boolean {
  if (tokens.length === 2) return true;
  let expectingValue = false;

  for (const token of tokens.slice(2)) {
    if (!token.startsWith("-")) {
      if (!expectingValue) return false;
      expectingValue = false;
      continue;
    }

    const flag = gitFlagName(token);
    if (
      MUTATING_GIT_BRANCH_FLAGS.has(flag) ||
      hasMutatingShortGitFlag(token, MUTATING_GIT_BRANCH_FLAGS)
    ) {
      return false;
    }
    const isReadOnlyValueFlag = READ_ONLY_GIT_BRANCH_VALUE_FLAGS.has(flag);
    const isReadOnlyBooleanFlag =
      READ_ONLY_GIT_BRANCH_BOOLEAN_FLAGS.has(flag) ||
      hasOnlyKnownShortGitFlags(token, READ_ONLY_GIT_BRANCH_SHORT_FLAGS);
    if (!isReadOnlyValueFlag && !isReadOnlyBooleanFlag) return false;
    expectingValue = !token.includes("=") && isReadOnlyValueFlag;
  }

  return true;
}

const MUTATING_GIT_TAG_FLAGS = new Set([
  "-a",
  "-d",
  "-f",
  "-m",
  "-s",
  "-u",
  "--annotate",
  "--delete",
  "--file",
  "--force",
  "--local-user",
  "--message",
  "--sign",
]);

const READ_ONLY_GIT_TAG_BOOLEAN_FLAGS = new Set(["--ignore-case", "--no-column"]);

const READ_ONLY_GIT_TAG_VALUE_FLAGS = new Set([
  "-l",
  "-n",
  "--column",
  "--contains",
  "--format",
  "--list",
  "--merged",
  "--no-contains",
  "--no-merged",
  "--points-at",
  "--sort",
]);

function isReadOnlyGitTag(tokens: string[]): boolean {
  if (tokens.length === 2) return true;
  let expectingValue = false;

  for (const token of tokens.slice(2)) {
    if (!token.startsWith("-")) {
      if (!expectingValue) return false;
      expectingValue = false;
      continue;
    }

    const flag = gitFlagName(token);
    if (
      MUTATING_GIT_TAG_FLAGS.has(flag) ||
      hasMutatingShortGitFlag(token, MUTATING_GIT_TAG_FLAGS)
    ) {
      return false;
    }
    const isReadOnlyValueFlag = READ_ONLY_GIT_TAG_VALUE_FLAGS.has(flag);
    const isReadOnlyBooleanFlag =
      READ_ONLY_GIT_TAG_BOOLEAN_FLAGS.has(flag) || /^-n\d*$/.test(token.toLowerCase());
    if (!isReadOnlyValueFlag && !isReadOnlyBooleanFlag) return false;
    expectingValue = !token.includes("=") && isReadOnlyValueFlag;
  }

  return true;
}

function isReadOnlyGitRemote(tokens: string[]): boolean {
  if (tokens.length === 2) return true;
  const action = tokens[2]?.toLowerCase();
  if ((action === "-v" || action === "--verbose") && tokens.length === 3) return true;
  if (action === "show") return true;
  if (action === "get-url") {
    return tokens.slice(3).every((token) => {
      const lower = token.toLowerCase();
      return lower === "--push" || lower === "--all" || !lower.startsWith("-");
    });
  }
  return false;
}

function isReadOnlyGitCommand(segment: string): boolean {
  const tokens = tokenize(segment);
  if (tokens[0]?.toLowerCase() !== "git") return false;

  switch (tokens[1]?.toLowerCase()) {
    case "branch":
      return isReadOnlyGitBranch(tokens);
    case "remote":
      return isReadOnlyGitRemote(tokens);
    case "tag":
      return isReadOnlyGitTag(tokens);
    case "stash": {
      const sub = tokens[2]?.toLowerCase();
      if (sub !== "show") return false; // git stash list remains in READ_ONLY_PREFIXES
      // git stash show: safe only without patch flags (-p/--patch/-u invoke diff.external)
      return tokens
        .slice(3)
        .every(
          (t) =>
            !GIT_DIFF_OUTPUT_FLAGS.has(t.toLowerCase()) &&
            !hasMutatingShortGitFlag(t, GIT_DIFF_OUTPUT_FLAGS),
        );
    }
    case "log":
      // git log -p/--patch/-u invokes diff.external in .git/config
      return tokens
        .slice(2)
        .every(
          (t) =>
            !GIT_DIFF_OUTPUT_FLAGS.has(t.toLowerCase()) &&
            !hasMutatingShortGitFlag(t, GIT_DIFF_OUTPUT_FLAGS),
        );
    case "reflog": {
      const sub = tokens[2]?.toLowerCase();
      // Mutating sub-commands: never auto-approve
      if (sub === "expire" || sub === "delete" || sub === "drop") return false;
      return tokens
        .slice(2)
        .every(
          (t) =>
            !GIT_DIFF_OUTPUT_FLAGS.has(t.toLowerCase()) &&
            !hasMutatingShortGitFlag(t, GIT_DIFF_OUTPUT_FLAGS),
        );
    }
    default:
      return false;
  }
}

function isReadOnlySegment(segment: string, shellMode: ShellMode = getShellMode()): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return true;

  // Must run before the cmdlet/prefix lookups so PowerShell aliases
  // (`cat`/`type`/`ls`) with UNC args are caught alongside the named cmdlets.
  if (hasRemoteAuthVector(trimmed, shellMode)) return false;

  const firstSpace = trimmed.search(/\s/);
  const firstToken = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();

  if (shellMode === "powershell") {
    // PowerShell control-flow keywords and comparison operators are inert
    // when they appear as a STANDALONE segment (i.e. the whole segment IS
    // the keyword). After `(...)` / `{...}` splitting, `if (Test-Path X) {
    // Get-ChildItem }` produces a segment that is exactly "if" — that's
    // safe. A segment like `if malicious_binary` has the keyword as first
    // token but ALSO has trailing content that we haven't analyzed; treating
    // it as inert would let any keyword-prefixed binary slip through.
    // Require `firstSpace === -1` so only true standalone keywords match.
    if (firstSpace === -1 && POWERSHELL_INERT_TOKENS.has(firstToken)) return true;
    if (isPureQuotedLiteral(trimmed)) return true;
    // A property-accessor tail like `.Version` or `.OS.Caption`. These
    // appear as standalone segments after the splitter cuts at `)` in
    // shapes like `(Get-CimInstance X).Version` — the parens get split
    // out, leaving `.Version` on its own. The companion guard in
    // `isReadOnlyCommand` rejects the whole command when it contains a
    // method-call shape (`.X(`), so by the time we reach here we know any
    // surviving `.X` segment is a property/index read, not a method call.
    if (/^\.\w[\w.]*$/.test(trimmed)) return true;
    // NOTE: a bare variable reference (`$flag`, `$env:USERPROFILE`) is
    // intentionally NOT treated as inert here. Variable contents are
    // policy-opaque — same posture as the bash `hasDynamicShellExpansion`
    // gate. Practical consequence: PowerShell scriptblocks with variable
    // conditions like `if ($flag) { ... }` won't auto-approve under
    // autoApproveReadOnly. The model can use deterministic conditions
    // (`if (Test-Path X)`) which DO auto-approve, or the user can add an
    // explicit allow-pattern. Adopting a smarter variable-taint analysis
    // here would need an actual PowerShell AST parser, not heuristics.
  }

  if (READ_ONLY_POWERSHELL_CMDLETS.has(firstToken)) return true;
  if (isReadOnlyAzCommand(trimmed)) return true;
  if (isReadOnlyGitCommand(trimmed)) return true;
  // Then the POSIX-style prefix list with word boundary enforcement.
  return READ_ONLY_PREFIXES.some((prefix) => {
    if (!trimmed.startsWith(prefix)) return false;
    // Require exact match or a word boundary (space/tab) after the prefix
    // to prevent "lsfoo" matching "ls" or "git statusx" matching "git status"
    return trimmed.length === prefix.length || /\s/.test(trimmed[prefix.length]);
  });
}

export function isReadOnlyCommand(command: string, shellMode: ShellMode = getShellMode()): boolean {
  const trimmed = command.trim().replace(VAR_ASSIGN_PREFIX_RE, "");
  // Reject unsafe shell syntax / dynamic expansion with quote-aware parsing.
  if (isUnsafeShellSyntax(trimmed, shellMode)) return false;
  // Reject newline/CR — shell treats these as command separators
  if (/[\r\n]/.test(trimmed)) return false;
  // SECURITY: in PowerShell mode, `.Method(...)` invokes a method on the
  // preceding expression. After splitShellSegments cuts at `(` and `)`, a
  // benign `.Version` accessor and a destructive `.Delete()` produce
  // identical `.<word>` segments — only the original command tells them
  // apart. `(Get-Item secrets.txt).Delete()` would otherwise classify
  // readonly via the property-accessor rule (both segments accepted),
  // even though the command deletes a file. There is no way to tell
  // side-effecting methods (`.Delete`, `.MoveTo`, `.SetAccessControl`,
  // `.WriteAllText`) from pure ones (`.ToString`, `.Substring`) without
  // an AST — reject the whole shape conservatively.
  if (shellMode === "powershell" && /\.\w+\s*\(/.test(trimmed)) return false;
  const split = splitShellSegments(trimmed, shellMode);
  if (split.segments.length > 1) {
    return split.segments.every((seg) => isReadOnlySegment(seg, shellMode));
  }
  return isReadOnlySegment(trimmed, shellMode);
}

// Git subcommands that are auto-approved as read-only. Used by client-factory.ts to
// inject GIT_CONFIG alias overrides into the Copilot CLI subprocess env — update this
// when READ_ONLY_PREFIXES or isReadOnlyGitCommand changes.
export const GIT_SAFE_ALIAS_SUBCOMMANDS = [
  "blame",
  "branch",
  "config",
  "config",
  "describe",
  "log",
  "reflog",
  "remote",
  "rev-parse",
  "shortlog",
  "stash",
  "submodule",
  "tag",
  "worktree",
] as const;

// Custom tools that only read data — safe to auto-approve when autoApproveReadOnly is on.
// Explicit map (not prefix matching) to avoid false positives on new or renamed tools.
// allowInUnattended: true  — safe to call when user is not present (internal state only)
// allowInUnattended: false — fetches attacker-controllable content or drives interactive UI
// Related: DEFAULT_TOOL_APPROVALS in common/marshal-tool-registry.ts (subset used for new-install defaults).
export const READ_ONLY_CUSTOM_TOOLS = new Map<string, { allowInUnattended: boolean }>([
  // Self-tools (read-only; recall updates lastAccessedAt metadata on disk — benign side effect)
  ["listRunningTools", { allowInUnattended: true }],
  ["inspectRunningTool", { allowInUnattended: true }],
  ["recall", { allowInUnattended: true }], // memory fact text is wrapped as untrusted before returning to the model
  ["listMemories", { allowInUnattended: true }], // same trust boundary as recall
  ["listAutomations", { allowInUnattended: true }],
  ["getAutomation", { allowInUnattended: true }], // step prompts are user-authored; mutations require explicit approval
  ["listModels", { allowInUnattended: true }],
  ["getCurrentModel", { allowInUnattended: true }],
  ["listSouls", { allowInUnattended: true }],
  ["getSettings", { allowInUnattended: true }],
  ["searchSessions", { allowInUnattended: true }],
  ["getSessionTranscript", { allowInUnattended: true }], // two-step attack path — prior session must already be compromised
  ["listWorkspaces", { allowInUnattended: true }],
  ["listRepositoryAgents", { allowInUnattended: true }],
  ["listSubagents", { allowInUnattended: true }],
  ["listSkills", { allowInUnattended: true }],
  ["getSkill", { allowInUnattended: true }], // user-authored; modifying a skill requires user-approved updateSkill (not zero-click)
  ["notificationStatus", { allowInUnattended: true }],
  // Interactive UI — must not fire when user is not present
  ["askUser", { allowInUnattended: false }],
  // Sleep/rest — benign control tool (no I/O, state change, or egress); safe to
  // run unattended (it just waits), so goal pursuit can rest without a prompt.
  ["sleep", { allowInUnattended: true }],
  // Dynamic Workflows — read-only (listings and run snapshots; no state change)
  ["workflowList", { allowInUnattended: true }],
  ["workflowGetRun", { allowInUnattended: true }],
  ["workflowListState", { allowInUnattended: true }],
  ["workflowReadState", { allowInUnattended: true }],
  ["workflowListArtifacts", { allowInUnattended: true }],
  ["workflowReadArtifact", { allowInUnattended: true }],
  ["workflowDescribe", { allowInUnattended: true }],
  // Goal snapshots are read-only.
  ["goalGet", { allowInUnattended: true }],
  // Local-file reads are normally normalized to read requests before this map,
  // but remain classified here so registry exhaustiveness is explicit.
  ["listLocalFiles", { allowInUnattended: true }],
  ["getLocalFileTree", { allowInUnattended: true }],
  ["statLocalPath", { allowInUnattended: true }],
]);

const INTERNAL_ORCHESTRATION_CUSTOM_TOOLS = new Set([
  "messageParent",
  "messageSubagent",
  "cancelQueuedSubagentMessages",
  "workflowSaveArtifact",
]);

/**
 * All mutating custom tools — tools that modify state, send messages, or
 * trigger actions. These default to "prompt" in the permission pipeline.
 *
 * This set exists for exhaustiveness tracking: every registered custom tool
 * must appear in exactly one of READ_ONLY_CUSTOM_TOOLS or MUTATING_CUSTOM_TOOLS.
 */
export const MUTATING_CUSTOM_TOOLS = new Set([
  // Self-tools (state-changing)
  "cancelRunningTool",
  "createAutomation",
  "updateAutomation",
  "deleteAutomation",
  "runAutomationNow",
  "setDefaultModel",
  "setSoul",
  "updateSettings",
  "requestPermissionEscalation",
  "remember",
  "forget",
  "setSessionTodos",
  // Deliberate, session-scoped external egress. Default approval is explicit in
  // common/marshal-tool-registry.ts; relay-origin turns are constrained to their source binding.
  "publishRelayMessage",
  "sendNotification",
  "registerWorkspace",
  "spawnSubagent",
  "spawnSubagents",
  "messageSubagent",
  "cancelQueuedSubagentMessages",
  "messageParent",
  "createSkill",
  "updateSkill",
  "deleteSkill",
  "deleteSession",
  "connectNotifications",
  "disconnectNotifications",
  "createLocalDirectory",
  "moveLocalPath",
  // Dynamic Workflows — mutating (start/cancel/retry runs; install workflow defs)
  "workflowRun",
  "workflowSaveArtifact",
  "workflowCancel",
  "workflowRetryFromStep",
  // Goal mutations and reviewer execution.
  "goalSet",
  "goalUpdateDefinition",
  "goalUpdateContext",
  "goalProposeTransition",
]);

export function isReadOnlyCustomTool(toolName: string): boolean {
  return READ_ONLY_CUSTOM_TOOLS.has(toolName);
}

export function isUnattendedSafeCustomTool(name: string): boolean {
  return READ_ONLY_CUSTOM_TOOLS.get(name)?.allowInUnattended === true;
}

export function getToolName(request: ApprovalRequest): string {
  if ("toolName" in request && typeof request.toolName === "string" && request.toolName) {
    return request.toolName;
  }
  return "";
}

export function getPermissionKey(request: ApprovalRequest): string {
  const toolName = getToolName(request);
  if (toolName) return `${request.kind}:${toolName}`;
  return request.kind;
}

export function getCommandText(request: ApprovalRequest): string {
  if (request.kind === "shell") {
    return request.command ?? "";
  }
  return "";
}

export { getShellCommandName } from "./shell-syntax-permission-utils";

/**
 * Return true if a shell command is a single invocation (no operators, no
 * subshell / heredoc smuggling). Used to gate auto-approve for built-in
 * shell capabilities: a leading capability token must not approve a dangerous
 * tail like `cmd arg ; rm -rf /`. The quote-aware splitter keeps operators
 * inside arguments from looking like extra shell invocations.
 */
export function isSingleShellInvocation(
  command: string,
  shellMode: ShellMode = getShellMode(),
): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  const split = splitShellSegments(cmd, shellMode);
  return split.segments.length === 1 && !isUnsafeShellSyntax(cmd, shellMode);
}

export const REVIEWER_VALIDATION_TOOL_NAME = "goalRunValidation";
export const REVIEWER_VALIDATION_ID_MAX_LENGTH = 256;
export const REVIEWER_VALIDATION_IDEMPOTENCY_KEY_MAX_LENGTH = 512;

export interface ReviewerToolClassification {
  decision: "approve" | "deny";
  reason: string;
  kind: ApprovalRequest["kind"];
}

const REVIEWER_APPROVE_REASON = "Approved as an explicit read-only reviewer operation.";

export const REVIEWER_ALLOWED_CUSTOM_TOOLS = [
  "glob",
  "grep",
  "listLocalFiles",
  "statLocalPath",
  "getLocalFileTree",
  "goalGet",
  "rg",
  "view",
  // Read-only transcript retrieval: the transition reviewer reads the goal's
  // sourceInstruction message verbatim instead of judging a summary of it.
  "getSessionTranscript",
] as const;

const REVIEWER_ALLOWED_CUSTOM_TOOL_SET: ReadonlySet<string> = new Set(
  REVIEWER_ALLOWED_CUSTOM_TOOLS.map((name) => name.toLowerCase()),
);

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reviewerToolArgs(toolArgs: unknown): Record<string, unknown> | null {
  if (toolArgs === undefined) return {};
  let parsed: unknown = toolArgs;
  if (typeof toolArgs === "string") {
    if (!toolArgs.trim().startsWith("{")) return null;
    try {
      // SF-4: reviewer tool args are treated as unknown and every consumed field is type-guarded.
      parsed = JSON.parse(toolArgs) as unknown;
    } catch {
      return null;
    }
  }
  return isUnknownRecord(parsed) ? parsed : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
  );
}

function isBoundedValidationId(
  value: unknown,
  maxLength = REVIEWER_VALIDATION_ID_MAX_LENGTH,
): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidationFence(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false;
  const fence = value;
  if (
    !hasExactKeys(fence, [
      "goalId",
      "contractRevision",
      "lifecycleEpoch",
      "specificationRevision",
      "specificationDigest",
    ])
  ) {
    return false;
  }
  return (
    isBoundedValidationId(fence.goalId) &&
    isNonNegativeSafeInteger(fence.contractRevision) &&
    isNonNegativeSafeInteger(fence.lifecycleEpoch) &&
    isNonNegativeSafeInteger(fence.specificationRevision) &&
    isBoundedValidationId(fence.specificationDigest)
  );
}

function isReviewerValidationRequest(args: unknown): args is ReviewerValidationPermissionRequest {
  if (!isUnknownRecord(args)) return false;
  const request = args;
  if (!hasExactKeys(request, ["fence", "validationNodeId", "commandId", "idempotencyKey"])) {
    return false;
  }
  return (
    isValidationFence(request.fence) &&
    isBoundedValidationId(request.validationNodeId) &&
    isBoundedValidationId(request.commandId) &&
    isBoundedValidationId(request.idempotencyKey, REVIEWER_VALIDATION_IDEMPOTENCY_KEY_MAX_LENGTH)
  );
}

function isStructurallyAuthorized(result: ReviewerValidationAuthorizationResult): boolean {
  if (result.kind !== "authorized") return false;
  const expiresAtMs = Date.parse(result.expiresAt);
  return (
    isBoundedValidationId(result.scopeId) &&
    isBoundedValidationId(result.commandSpecDigest) &&
    Number.isFinite(expiresAtMs) &&
    new Date(expiresAtMs).toISOString() === result.expiresAt &&
    expiresAtMs > Date.now()
  );
}

function hasExactReviewerSessionCapabilities(
  scope: ReviewerSessionPermissionScope | undefined,
): boolean {
  if (!scope) return false;
  return (
    scope.permissionMode === REVIEWER_SESSION_CAPABILITIES.permissionMode &&
    scope.networkAccess === REVIEWER_SESSION_CAPABILITIES.networkAccess &&
    scope.credentialAccess === REVIEWER_SESSION_CAPABILITIES.credentialAccess &&
    scope.validationExecution === REVIEWER_SESSION_CAPABILITIES.validationExecution &&
    scope.shellAccess === REVIEWER_SESSION_CAPABILITIES.shellAccess
  );
}

function resolveSessionPermissionMode(
  configuredMode: SessionPermissionMode | undefined,
  reviewerScope: ReviewerSessionPermissionScope | undefined,
): SessionPermissionMode | undefined {
  if (hasExactReviewerSessionCapabilities(reviewerScope)) {
    return REVIEWER_SESSION_CAPABILITIES.permissionMode;
  }
  return configuredMode ?? reviewerScope?.permissionMode;
}

function hasReviewerValidationExecutor(
  executor: IReviewerValidationExecutorPort | undefined,
): executor is IReviewerValidationExecutorPort {
  return (
    typeof executor?.getCommandSpec === "function" &&
    typeof executor.executeValidation === "function"
  );
}

function hasReviewerValidationAuthorization(
  authorization: IReviewerValidationAuthorizationPort | undefined,
): authorization is IReviewerValidationAuthorizationPort {
  return typeof authorization?.authorizeReviewerValidation === "function";
}

/**
 * Fail-closed capability classifier for goal reviewer sessions. It deliberately
 * ignores MCP readOnly hints and persisted allow rules: only operations named
 * here can run. Raw shell and network tools are never reviewer capabilities.
 */
export class ReviewerToolPolicy {
  classifyPermissionRequest(
    request: ApprovalRequest,
    scope: ReviewerSessionPermissionScope | undefined,
    validationExecutor: IReviewerValidationExecutorPort | undefined,
    validationAuthorization: IReviewerValidationAuthorizationPort | undefined,
  ): ReviewerToolClassification {
    if (!hasExactReviewerSessionCapabilities(scope)) return this.deny(request.kind);
    switch (request.kind) {
      case "read":
        return this.approve("read");
      case "write":
      case "settings":
      case "memory":
      case "hook":
        return this.deny(request.kind);
      case "url":
        return this.deny("url");
      case "shell":
        return this.deny("shell");
      case "custom-tool":
        return this.classifyNamedTool(
          request.sessionId,
          request.toolName,
          request.toolArgs,
          validationExecutor,
          validationAuthorization,
        );
      case "mcp":
        return this.deny("mcp");
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  }

  classifyToolInvocation(
    sessionId: string,
    toolName: string,
    toolArgs: unknown,
    scope: ReviewerSessionPermissionScope | undefined,
    validationExecutor: IReviewerValidationExecutorPort | undefined,
    validationAuthorization: IReviewerValidationAuthorizationPort | undefined,
  ): ReviewerToolClassification {
    if (!hasExactReviewerSessionCapabilities(scope)) return this.deny("custom-tool");
    const lower = toolName.trim().toLowerCase();
    return this.classifyNamedTool(
      sessionId,
      lower,
      toolArgs,
      validationExecutor,
      validationAuthorization,
    );
  }

  private classifyNamedTool(
    sessionId: string,
    toolName: string,
    toolArgs: unknown,
    validationExecutor: IReviewerValidationExecutorPort | undefined,
    validationAuthorization: IReviewerValidationAuthorizationPort | undefined,
  ): ReviewerToolClassification {
    const lower = toolName.trim().toLowerCase();
    if (REVIEWER_ALLOWED_CUSTOM_TOOL_SET.has(lower)) return this.approve("custom-tool");
    if (lower === REVIEWER_VALIDATION_TOOL_NAME.toLowerCase()) {
      const args = reviewerToolArgs(toolArgs);
      // Authorization owns live scope/fence/spec/replay checks. The handler
      // constructs requestedAt, then the executor revalidates before execution.
      if (
        isReviewerValidationRequest(args) &&
        hasReviewerValidationExecutor(validationExecutor) &&
        hasReviewerValidationAuthorization(validationAuthorization)
      ) {
        const authorization = validationAuthorization.authorizeReviewerValidation(sessionId, args);
        if (isStructurallyAuthorized(authorization)) return this.approve("custom-tool");
      }
    }
    return this.deny("custom-tool");
  }

  private approve(kind: ApprovalRequest["kind"]): ReviewerToolClassification {
    return { decision: "approve", reason: REVIEWER_APPROVE_REASON, kind };
  }

  private deny(kind: ApprovalRequest["kind"]): ReviewerToolClassification {
    return { decision: "deny", reason: REVIEWER_DENY_REASON, kind };
  }
}

/**
 * Map an MCP tool name to its permissions.servers config key by matching the
 * leading segment. The SDK uses two boundary conventions:
 *   - Playwright-style: `<key>-<toolName>` (e.g. `playwright-browser_navigate`)
 *   - Double-underscore: `<key>__<toolName>` (e.g. `filesystem__read_file`)
 * Also matches the exact tool name (useful for custom-server roots).
 *
 * Keys are tried longest-first so that a custom server like `play` cannot
 * shadow the built-in `playwright` — most-specific-prefix wins regardless of
 * caller iteration order.
 */
export function resolveMcpServerFromToolName(toolName: string, knownServerKeys: string[]): string {
  if (!toolName) return "";
  const tl = toolName.toLowerCase();
  const sorted = [...knownServerKeys].sort((a, b) => b.length - a.length);
  for (const key of sorted) {
    // Skip empty-string keys: an accidental "" entry in permissions.servers
    // would otherwise match every tool starting with "-" or "__".
    if (!key) continue;
    // Lowercase the key too for symmetry — built-in keys are all lowercase by
    // convention and custom-server keys go through `name.toLowerCase()` in
    // mcp-tools.ts, but a hand-edited permissions.servers entry with mixed
    // case shouldn't silently fail to match a (lowercased) tool name.
    const k = key.toLowerCase();
    if (tl === k || tl.startsWith(`${k}-`) || tl.startsWith(`${k}__`)) {
      return key;
    }
  }
  return "";
}

export function resolveEffectiveServerName(
  request: ApprovalRequest,
  permissions: PermissionsConfig,
): string {
  const explicitServer = getServerName(request);
  const mcpResolvedServer =
    !explicitServer && request.kind === "mcp"
      ? resolveMcpServerFromToolName(request.toolName, Object.keys(permissions.servers))
      : "";
  const serverName = explicitServer || mcpResolvedServer || request.kind;
  return (!permissions.servers[serverName] && KIND_TO_SERVER_FALLBACK[serverName]) || serverName;
}

export function getServerName(request: ApprovalRequest): string {
  if (request.kind === "mcp") return request.serverName ?? "";
  if (request.kind === "shell") return request.serverName;
  return "";
}

interface PermissionPolicyDeps {
  settingsManager: SettingsManager;
  getPermissionMode?: (sessionId: string) => SessionPermissionMode;
  getReviewerSessionPermissionScope?: (
    sessionId: string,
  ) => ReviewerSessionPermissionScope | undefined;
  reviewerValidationExecutor?: IReviewerValidationExecutorPort;
  reviewerValidationAuthorization?: IReviewerValidationAuthorizationPort;
  tenantPolicy?: TenantPolicyProvider;
  /** All MCP server config keys known at runtime (built-in `filesystem` /
   *  `playwright` plus normalized custom-server keys). Used to discriminate
   *  MCP tool calls from non-MCP tools (self-tools, shell) when a
   *  session has an explicit MCP scope. Optional — when omitted,
   *  per-session MCP scoping degrades to a no-op (the session sees the
   *  global MCP set). Wired in `main.ts` from `mcpStatus`. See
   *  R1-FIXES A13. */
  getKnownMcpKeys?: () => readonly string[];
  workspaceDir?: string;
  getWorkspaceRootForSession?: (sessionId: string) => string | undefined;
  hasWorkspaceScopeForSession?: (sessionId: string) => boolean;
  /**
   * Static directories the Marshal filesystem self-tools may access without a
   * folder-grant card — installed skill resource dirs and the automations
   * resource dir. These were extra allowed roots on the old filesystem MCP
   * and are merged into effective read+write grants here so both the policy
   * (no card) and the handler guard see them. Tenant restrictToWorkspace
   * strips them. Omitted in tests that don't exercise resource access.
   */
  getResourceFolderRoots?: () => string[];
}

/**
 * Centralized permission policy. All auto-approve, deny, and prompt
 * decisions are made here — no permission logic should live outside this class.
 */
export class PermissionPolicy implements IPermissionPolicy {
  // Per-entity permissions — full replacement for global when registered.
  // Used by automations, heartbeat, and "Allow for session" button.
  private entitySessionPermissions = new Map<string, PermissionsConfig>();
  // Persist callbacks for entity sessions — called when "Always allow" updates entity permissions.
  private entitySessionCallbacks = new Map<string, (updated: PermissionsConfig) => void>();
  // Sessions where unapproved tool calls are auto-denied instead of prompting.
  // Used by background runners (heartbeat, automations) that can't show permission UI.
  private sessionDenyPrompt = new Set<string>();
  // Sessions running unattended (heartbeat, automations) — custom-tool auto-approve
  // uses the stricter unattended-safe set to exclude attacker-controllable tools.
  private unattendedSessions = new Set<string>();
  // Per-chat-session "Allow for session" diffs, overlaid on global at read time.
  // In-memory only; lost on app restart, matching the legacy clone's lifetime.
  private sessionAdditions = new Map<
    string,
    { allow: string[]; tools: Record<string, true>; readFolders: string[]; writeFolders: string[] }
  >();
  // Per-session MCP allowlist (R1-FIXES A13). Set by `SessionManager.createBackendSession`
  // when the session record carries `scopedMcp`. Stored as a lowercased Set so the
  // boundary match in `checkSessionScopedMcp` mirrors `checkUserDisabledTool`.
  // Absence = no scope (inherit global); empty set = block all MCP servers.
  private sessionMcpScope = new Map<string, ReadonlySet<string>>();
  // Optional callback fired when a deny-prompt session has a tool blocked.
  private onDenyPromptCallback: ((sessionId: string, kind: string, detail: string) => void) | null =
    null;
  private deps: PermissionPolicyDeps;
  private reviewerToolPolicy = new ReviewerToolPolicy();
  private auditLogger: AuditLogger | null = null;
  /** Optional callback fired after `persistAllowRule` writes a new rule.
   *  Wired by `PermissionCardManager.connectPolicy` to defuse parallel
   *  pending bursts in the originating session. Singleton-by-design.
   *  Scoped to the originating sessionId so entity rules don't fan out. */
  private onAlwaysAllowAddedCallback: ((sessionId: string) => void) | null = null;

  constructor(deps: PermissionPolicyDeps) {
    this.deps = deps;
  }

  /** Get the global permissions config from settings, falling back to defaults. */
  private getPermissions(): PermissionsConfig {
    return this.deps.settingsManager.get().permissions ?? FALLBACK_PERMISSIONS;
  }

  /** Get the current global permissions (for callers that need to derive entity defaults). */
  getGlobalPermissions(): PermissionsConfig {
    return this.getPermissions();
  }

  /** Wire the audit logger (called from main.ts after construction). */
  setAuditLogger(logger: AuditLogger): void {
    this.auditLogger = logger;
  }

  /**
   * Wire a callback fired after `persistAllowRule` writes a new auto-approve
   * rule. The argument is `request.sessionId` from the triggering click.
   * Singleton-by-design: throws if a callback is already registered, so a
   * future second listener can't silently displace the first.
   */
  setOnAlwaysAllowAdded(cb: (sessionId: string) => void): void {
    if (this.onAlwaysAllowAddedCallback) {
      throw new Error(
        "setOnAlwaysAllowAdded: a callback is already registered. Only one listener is supported.",
      );
    }
    this.onAlwaysAllowAddedCallback = cb;
  }

  /**
   * Emit a single audit row for a sibling permission request that the burst
   * defuser auto-resolved. Tagged `policy-burst-defuser` so the trail is
   * distinguishable from both `policy-auto-approve` (rule already existed at
   * evaluate time) and `user-interactive` (the user clicked a card).
   * Decision is always `approved` — the defuser only fires for siblings that
   * the new always-allow rule now approves.
   */
  recordAutoResolvedSibling(request: ApprovalRequest): void {
    this.audit(request, "approved", "policy-burst-defuser", "approved");
  }

  /** Emit an audit row for a pending prompt resolved after a policy update. */
  recordAutoApprovedByPolicy(request: ApprovalRequest): void {
    this.audit(request, "approved", "policy-auto-approve", "approved");
  }

  /** Internal: append a permission decision to the audit log. */
  private audit(
    request: ApprovalRequest,
    decision: "approved" | "denied",
    source: AuditDecisionSource,
    sdkResult: string,
    userAction?: PermissionAction,
    persistedRule?: boolean,
  ): void {
    if (!this.auditLogger) return;
    this.auditLogger.log({
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      kind: request.kind,
      toolName: getToolName(request),
      serverName: getServerName(request),
      commandText: getCommandText(request),
      decision,
      source,
      sdkResult,
      ...(userAction ? { userAction } : {}),
      ...(persistedRule !== undefined ? { persistedRule } : {}),
    });
  }

  /**
   * Evaluate a permission request and return the decision.
   * Explicit reviewer and allow-all modes run before the normal first-match
   * pipeline. Always emits an audit log entry on auto-approve / auto-deny.
   * Speculative callers that emit their
   * own dedicated audit row (e.g., the burst defuser) MUST use
   * {@link evaluateSilent} instead to avoid double-logging.
   */
  evaluate(request: ApprovalRequest): PermissionDecision {
    return this.evaluateInternal(request, true).decision;
  }

  /**
   * Like {@link evaluate} but also returns a human-readable `denyReason` for
   * hard `deny` outcomes, so the CopilotBackend can surface an accurate,
   * actionable message to the model instead of the generic "could not request
   * permission from user" string.
   */
  evaluateDetailed(request: ApprovalRequest): PolicyEvaluation {
    return this.evaluateInternal(request, true);
  }

  /**
   * Speculative variant of {@link evaluate} that suppresses audit log
   * entries. Intended for internal speculative re-evaluation paths
   * (today: `PermissionCardManager`'s burst defuser) which emit their own
   * dedicated audit row via {@link recordAutoResolvedSibling}. Not part of
   * the general public API — adding new callers risks double-logging gaps
   * because the silent path writes nothing.
   *
   * @internal
   */
  evaluateSilent(request: ApprovalRequest): PermissionDecision {
    return this.evaluateInternal(request, false).decision;
  }

  /**
   * Evaluate only policy outcomes that cannot be overridden by an interactive
   * approval or a permissive session mode.
   */
  evaluateHardDenial(request: ApprovalRequest): PolicyEvaluation {
    const permissions = this.getEffectivePermissions(request.sessionId);
    if (this.isWorkspaceScopeUnavailable(request.sessionId)) {
      const denyReason =
        "The session workspace is unavailable. Restore it or choose another scope.";
      this.audit(request, "denied", "policy-auto-deny", "denied-by-rules");
      return { decision: "deny", denyReason };
    }
    const effectiveServerName = resolveEffectiveServerName(request, permissions);
    const reviewerScope = this.deps.getReviewerSessionPermissionScope?.(request.sessionId);
    const permissionMode = resolveSessionPermissionMode(
      this.deps.getPermissionMode?.(request.sessionId),
      reviewerScope,
    );
    const ctx: RulePolicyContext = {
      permissions,
      effectiveServerName,
      serverConfig: permissions.servers[effectiveServerName],
      tenantPolicy: this.deps.tenantPolicy,
      allowAllMode: permissionMode === "allow-all",
      unattendedSessions: this.unattendedSessions,
      sessionDenyPrompt: this.sessionDenyPrompt,
      onDenyPromptCallback: this.onDenyPromptCallback ?? undefined,
      workspaceDir: this.getWorkspaceDirForSession(request.sessionId),
    };
    for (const rule of POLICY_RULES) {
      const result = rule.apply(request, ctx);
      if (result?.decision === "deny") {
        return this.evaluationFromRule(request, rule, result, true);
      }
    }
    return { decision: "prompt" };
  }

  /**
   * Returns the sensitive-path hit for a request, or null if the request
   * does not target a sensitive location. Used by PermissionCardManager to
   * set sensitivePathWarning on permission cards.
   */
  getSensitivePathHit(request: ApprovalRequest): SensitivePathHit | null {
    const permissions = this.getEffectivePermissions(request.sessionId);
    return checkSensitivePath(request, permissions.allowedSensitivePaths ?? []);
  }

  private evaluateInternal(request: ApprovalRequest, shouldAudit: boolean): PolicyEvaluation {
    const permissions = this.getEffectivePermissions(request.sessionId);
    const effectiveServerName = resolveEffectiveServerName(request, permissions);
    const reviewerScope = this.deps.getReviewerSessionPermissionScope?.(request.sessionId);
    const permissionMode = resolveSessionPermissionMode(
      this.deps.getPermissionMode?.(request.sessionId),
      reviewerScope,
    );
    if (this.isWorkspaceScopeUnavailable(request.sessionId)) {
      const denyReason =
        "The session workspace is unavailable. Restore it or choose another scope.";
      if (shouldAudit) {
        this.audit(request, "denied", "policy-auto-deny", "denied-by-rules");
      }
      return { decision: "deny", denyReason };
    }
    const ctx: RulePolicyContext = {
      permissions,
      effectiveServerName,
      serverConfig: permissions.servers[effectiveServerName],
      tenantPolicy: this.deps.tenantPolicy,
      allowAllMode: permissionMode === "allow-all",
      unattendedSessions: this.unattendedSessions,
      sessionDenyPrompt: this.sessionDenyPrompt,
      onDenyPromptCallback: this.onDenyPromptCallback ?? undefined,
      workspaceDir: this.getWorkspaceDirForSession(request.sessionId),
    };
    if (permissionMode === "read-only-reviewer") {
      const tenantDeny = TENANT_DENY_RULE.apply(request, ctx);
      if (tenantDeny) {
        return this.evaluationFromRule(request, TENANT_DENY_RULE, tenantDeny, shouldAudit);
      }

      const classification = this.reviewerToolPolicy.classifyPermissionRequest(
        request,
        reviewerScope,
        this.deps.reviewerValidationExecutor,
        this.deps.reviewerValidationAuthorization,
      );
      if (classification.decision === "deny") {
        if (shouldAudit) {
          this.audit(request, "denied", "policy-auto-deny", "denied-by-rules");
        }
        return { decision: "deny", denyReason: classification.reason };
      }

      const authorityRules: EvaluationPolicyRule[] = [
        TENANT_FORCE_PROMPT_RULE,
        SENSITIVE_PATH_GATE_RULE,
        SERVER_DISABLED_RULE,
        ...(request.kind === "read" ? [FOLDER_GRANT_RULE] : []),
      ];
      for (const rule of authorityRules) {
        const result = rule.apply(request, ctx);
        if (result) return this.evaluationFromRule(request, rule, result, shouldAudit);
      }

      if (shouldAudit) {
        this.audit(request, "approved", "policy-auto-approve", "approved");
      }
      return { decision: "approve" };
    }
    if (ctx.allowAllMode) {
      if (shouldAudit) {
        this.audit(request, "approved", "policy-auto-approve", "approved");
      }
      return { decision: "approve" };
    }
    for (const rule of POLICY_RULES) {
      const result = rule.apply(request, ctx);
      if (result === null) {
        // Step 6b: Parent/subagent control-plane messaging is internal
        // orchestration, not an external side effect. Injected after the
        // generic read-only auto-approve so tenant force-prompt/deny still
        // win above. Keeps messageParent / messageSubagent silent.
        if (rule.id === "read-only-auto-approve") {
          if (
            request.kind === "custom-tool" &&
            INTERNAL_ORCHESTRATION_CUSTOM_TOOLS.has(getToolName(request))
          ) {
            if (shouldAudit) {
              this.audit(request, "approved", "policy-auto-approve", "approved");
            }
            return { decision: "approve" };
          }
        }
        continue;
      }
      return this.evaluationFromRule(request, rule, result, shouldAudit);
    }
    throw new Error(
      "permission-policy: POLICY_RULES list did not terminate — DEFAULT_PROMPT_RULE missing",
    );
  }

  private evaluationFromRule(
    request: ApprovalRequest,
    rule: EvaluationPolicyRule,
    result: RuleResult,
    shouldAudit: boolean,
  ): PolicyEvaluation {
    if (shouldAudit && result.auditOutcome !== undefined) {
      const sdkResult =
        result.sdkResult ?? (result.auditOutcome === "approved" ? "approved" : "denied-by-rules");
      this.audit(request, result.auditOutcome, rule.auditSource, sdkResult);
    }
    return {
      decision: result.decision,
      denyReason: result.decision === "deny" ? denyReasonForRule(rule.id) : undefined,
    };
  }

  /**
   * Log an interactive outcome (user approved/denied) and record it in policy state.
   * Called by PermissionCardManager after the user responds or a timeout/no-window occurs.
   */
  recordInteractiveOutcome(
    request: ApprovalRequest,
    action: PermissionAction,
    decision: ApprovalDecision,
  ): boolean {
    const isApproved =
      action === "allow" ||
      action === "allow-type" ||
      action === "allow-all" ||
      action === "allow-session" ||
      action === "always-allow";
    if (isApproved && this.isWorkspaceScopeUnavailable(request.sessionId)) {
      this.audit(request, "denied", "policy-auto-deny", "denied-by-rules", action);
      return false;
    }

    // Drive persistence first so the audit row can record whether a rule
    // actually landed. Only meaningful for always-allow; undefined for
    // other actions (they don't persist a per-rule allow row).
    const persisted = this.recordDecision(action, request);
    const persistedRule = action === "always-allow" ? persisted : undefined;

    this.audit(
      request,
      isApproved ? "approved" : "denied",
      "user-interactive",
      decision,
      action,
      persistedRule,
    );
    return isApproved;
  }

  /** Log a no-window or timeout denial (no user action to record). */
  logInfraFailure(request: ApprovalRequest, source: "no-window" | "timeout"): void {
    this.audit(request, "denied", source, "denied-by-rules");
  }

  /**
   * Log a pre-hook decision (onPreToolUse / permissionHandler sites that run before evaluate()).
   * Uses named fields instead of positional params to prevent argument-order mistakes.
   */
  logPreHookDecision(opts: {
    sessionId: string;
    toolCallId?: string;
    toolName: string;
    serverName: string;
    kind: string;
    decision: "approved" | "denied";
    source: AuditDecisionSource;
    sdkResult: string;
  }): void {
    if (!this.auditLogger) return;
    this.auditLogger.log({
      sessionId: opts.sessionId,
      toolCallId: opts.toolCallId,
      kind: opts.kind,
      toolName: opts.toolName,
      serverName: opts.serverName,
      commandText: "",
      decision: opts.decision,
      source: opts.source,
      sdkResult: opts.sdkResult,
    });
  }

  private buildPreHookContext(opts: {
    sessionId: string;
    toolCallId?: string;
    toolName: string;
    toolArgs?: unknown;
    fileUploadEnabled?: boolean;
  }): PolicyContext {
    return {
      sessionId: opts.sessionId,
      toolCallId: opts.toolCallId,
      toolName: opts.toolName,
      toolArgs: opts.toolArgs,
      fileUploadEnabled: opts.fileUploadEnabled === true,
      permissions: this.getEffectivePermissions(opts.sessionId),
      tenantPolicy: this.deps.tenantPolicy,
    };
  }

  /** Effective out-of-workspace folder grants for a session — global plus any
   *  "allow for session" / entity-session additions. Used by the Marshal filesystem
   *  tools' realpath guard so it re-checks against exactly what the policy approved. */
  getEffectiveFolderGrants(sessionId: string): { read: string[]; write: string[] } {
    const perms = this.getEffectivePermissions(sessionId);
    return { read: perms.allowedReadFolders ?? [], write: perms.allowedWriteFolders ?? [] };
  }

  isMcpServerEnabledForSession(sessionId: string, serverKey: string): boolean {
    const key = toMcpServerKey(serverKey);
    const permissions = this.getEffectivePermissions(sessionId);
    const userEntry = Object.entries(permissions.servers ?? {}).find(
      ([candidate]) => toMcpServerKey(candidate) === key,
    );
    if (userEntry?.[1]?.enabled === false) return false;

    const scope = this.sessionMcpScope.get(sessionId);
    if (scope && !scope.has(key)) return false;

    const displayName = CONFIG_KEY_TO_DISPLAY_NAME[key] ?? serverKey;
    return !(this.deps.tenantPolicy?.get()?.disabledServers ?? []).some((entry) => {
      const lower = entry.toLowerCase();
      return lower === displayName.toLowerCase() || toMcpServerKey(entry) === key;
    });
  }

  /**
   * Evaluate pre-hook checks that run before the SDK's permissionHandler.
   * Checks tenant-disabled servers, fail-closed reviewer restrictions,
   * user-disabled servers, and tool-specific gates. Returns a deny result if
   * the tool should be blocked, or null to continue.
   */
  evaluatePreHook(opts: {
    sessionId: string;
    toolCallId?: string;
    toolName: string;
    toolArgs?: unknown;
    fileUploadEnabled?: boolean;
  }): PreHookDeny | null {
    const ctx = this.buildPreHookContext(opts);
    const tenantDeny = TENANT_DISABLED_SERVER.preHook(ctx);
    if (tenantDeny) {
      this.logPreHookDecision({
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        toolName: ctx.toolName,
        serverName: tenantDeny.serverName ?? TENANT_DISABLED_SERVER.serverName ?? "",
        kind: tenantDeny.kind ?? TENANT_DISABLED_SERVER.kind ?? "mcp",
        decision: "denied",
        source: TENANT_DISABLED_SERVER.source,
        sdkResult: "denied-by-rules",
      });
      return {
        permissionDecision: "deny",
        permissionDecisionReason: tenantDeny.permissionDecisionReason,
      };
    }

    const reviewerScope = this.deps.getReviewerSessionPermissionScope?.(ctx.sessionId);
    const permissionMode = resolveSessionPermissionMode(
      this.deps.getPermissionMode?.(ctx.sessionId),
      reviewerScope,
    );
    if (permissionMode === "read-only-reviewer") {
      const classification = this.reviewerToolPolicy.classifyToolInvocation(
        ctx.sessionId,
        ctx.toolName,
        ctx.toolArgs,
        reviewerScope,
        this.deps.reviewerValidationExecutor,
        this.deps.reviewerValidationAuthorization,
      );
      if (classification.decision === "deny") {
        this.logPreHookDecision({
          sessionId: ctx.sessionId,
          toolCallId: ctx.toolCallId,
          toolName: ctx.toolName,
          serverName: "",
          kind: classification.kind,
          decision: "denied",
          source: "pre-hook-blocked-tool",
          sdkResult: "denied-by-rules",
        });
        return {
          permissionDecision: "deny",
          permissionDecisionReason: classification.reason,
        };
      }
    }

    for (const rule of POLICY_PRE_HOOK_RULES) {
      if (rule.id === TENANT_DISABLED_SERVER.id) continue;
      const deny = rule.preHook(ctx);
      if (!deny) continue;

      this.logPreHookDecision({
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        toolName: ctx.toolName,
        serverName: deny.serverName ?? rule.serverName ?? "",
        kind: deny.kind ?? rule.kind ?? "mcp",
        decision: "denied",
        source: rule.source,
        sdkResult: "denied-by-rules",
      });
      return {
        permissionDecision: "deny",
        permissionDecisionReason: deny.permissionDecisionReason,
      };
    }

    // Per-session MCP scope (R1-FIXES A13). The workflow engine sets a scope
    // via `setSessionMcpScope` when `ctx.spawn`/`ctx.run` is invoked with
    // explicit `mcp: [...]`. Tools belonging to MCP servers outside the
    // scope are denied even though the SDK still surfaces them. Reuses the
    // `pre-hook-disabled-server` audit source so dashboards aggregating by
    // source don't grow a new bucket for a niche reason; the deny message
    // disambiguates for end users.
    const scopeBlocked = this.checkSessionScopedMcp(ctx.sessionId, ctx.toolName);
    if (scopeBlocked) {
      this.logPreHookDecision({
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        toolName: ctx.toolName,
        serverName: scopeBlocked,
        kind: "mcp",
        decision: "denied",
        source: "pre-hook-disabled-server",
        sdkResult: "denied-by-rules",
      });
      return {
        permissionDecision: "deny",
        permissionDecisionReason: `${scopeBlocked} is not in this session's MCP scope.`,
      };
    }

    return null; // no pre-hook denial, continue to permission handler
  }

  /**
   * Record a user's decision from a permission card.
   * Updates session-scoped or disk-persisted state for future auto-approve.
   */
  recordDecision(action: PermissionAction, request: ApprovalRequest): boolean {
    if (this.isWorkspaceScopeUnavailable(request.sessionId)) return false;
    if ((request.kind === "read" || request.kind === "write") && this.isOutsideWorkspace(request)) {
      return this.recordFolderGrant(action, request);
    }
    switch (action) {
      case "allow":
      case "deny":
      case "allow-type": // Legacy no-op — old UI buttons, no modern equivalent
      case "allow-all": // Legacy no-op — old UI buttons, no modern equivalent
        return false;
      case "allow-session": {
        const entityConfig = this.entitySessionPermissions.get(request.sessionId);
        if (entityConfig) {
          return this.addApprovalToConfig(entityConfig, request);
        } else {
          return this.addToSessionAdditions(request);
        }
      }
      case "always-allow":
        return this.persistAllowRule(request);
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  // Shared by addApprovalToConfig and addToSessionAdditions so the heuristic +
  // guardrails machinery doesn't drift between the two write paths.
  private extractApprovalRule(request: ApprovalRequest): ApprovalRule {
    if (request.kind === "shell") {
      if (
        request.approvalPattern &&
        request.approvalPattern.trim() &&
        request.approvalPattern.trim() !== "*"
      ) {
        const patterns = this.getGuardedShellPatterns(request.approvalPattern, {
          fallbackToExact: false,
        });
        if (patterns.length > 0) return { kind: "allow", patterns };
      }

      const command = getCommandText(request);
      if (!command) return null;
      const patterns = this.getGuardedShellPatterns(command);
      return patterns.length > 0 ? { kind: "allow", patterns } : null;
    }

    // Non-shell
    const patternKey = getPatternKey(request);
    if (!patternKey) return null;
    if (patternKey.startsWith("tool:") || patternKey.startsWith("mcp:")) {
      return { kind: "tool", key: patternKey };
    }
    return { kind: "allow", patterns: [patternKey] };
  }

  private addShellPatternsToConfig(config: PermissionsConfig, patterns: string[]): boolean {
    let changed = false;
    for (const pattern of patterns) {
      const trimmed = pattern.trim();
      if (!trimmed || trimmed === "*" || config.allow.includes(trimmed)) continue;
      config.allow.push(trimmed);
      changed = true;
    }
    return changed;
  }

  private getGuardedShellPatterns(
    command: string,
    {
      fallbackToExact = true,
      shellMode = getShellMode(),
    }: { fallbackToExact?: boolean; shellMode?: ShellMode } = {},
  ): string[] {
    const exactCommand = command.trim();
    const exactFallback = () => (fallbackToExact && exactCommand ? [exactCommand] : []);
    const split = splitShellSegments(command, shellMode);

    if (split.segments.length > 1 && !split.hasUnsafeSyntax) {
      const patterns: string[] = [];
      const seen = new Set<string>();

      for (const segment of split.segments) {
        const heuristic = extractPattern(segment, shellMode);
        if (!heuristic || heuristic.trim() === "*") return exactFallback();

        const gated = applyGuardrails(
          segment,
          {
            explanation: "",
            category: "unknown",
            suggestedPattern: heuristic,
            patternRationale: null,
            source: "fallback",
            guardrailRuleId: null,
          },
          { isReadOnlyCommand, shellMode },
        );

        if (!gated.suggestedPattern) return exactFallback();

        for (const pattern of extractPatterns(gated.suggestedPattern, shellMode)) {
          if (seen.has(pattern)) continue;
          seen.add(pattern);
          patterns.push(pattern);
        }
      }

      return patterns;
    }

    const heuristic = extractPattern(command, shellMode);
    // If extractPattern collapses the whole command to "*" (all variables/paths),
    // the command is unrepresentable as a pattern — skip storage entirely.
    if (!heuristic || heuristic.trim() === "*") return [];

    const gated = applyGuardrails(
      command,
      {
        explanation: "",
        category: "unknown",
        suggestedPattern: heuristic,
        patternRationale: null,
        source: "fallback",
        guardrailRuleId: null,
      },
      { isReadOnlyCommand, shellMode },
    );

    return gated.suggestedPattern
      ? extractPatterns(gated.suggestedPattern, shellMode)
      : exactFallback();
  }

  /** Add an approved pattern to a PermissionsConfig (mutates in-place).
   *  Returns true when the config actually changed — callers rely on this to
   *  decide whether to persist. Do NOT infer "no change" from key-count or
   *  array-length deltas: flipping an existing `tools[key]` from false to true
   *  is a real change that leaves the key count unchanged. */
  private addApprovalToConfig(config: PermissionsConfig, request: ApprovalRequest): boolean {
    const rule = this.extractApprovalRule(request);
    if (!rule) return false;
    if (rule.kind === "tool") {
      if (config.tools[rule.key]) return false;
      config.tools[rule.key] = true;
      return true;
    }
    return this.addShellPatternsToConfig(config, rule.patterns);
  }

  private addToSessionAdditions(request: ApprovalRequest): boolean {
    const rule = this.extractApprovalRule(request);
    if (!rule) return false;

    let adds = this.sessionAdditions.get(request.sessionId);
    if (!adds) {
      adds = { allow: [], tools: {}, readFolders: [], writeFolders: [] };
      this.sessionAdditions.set(request.sessionId, adds);
    }

    if (rule.kind === "tool") {
      if (adds.tools[rule.key]) return false;
      adds.tools[rule.key] = true;
      return true;
    }

    let changed = false;
    for (const pattern of rule.patterns) {
      const trimmed = pattern.trim();
      if (!trimmed || trimmed === "*" || adds.allow.includes(trimmed)) continue;
      adds.allow.push(trimmed);
      changed = true;
    }
    return changed;
  }

  // Shallow merge is sufficient because session additions only touch `allow`,
  // `tools`, `readFolders`, and `writeFolders`. Other fields flow through from
  // global by reference, so the return is typed Readonly to make the no-mutate
  // contract enforceable.
  private getEffectivePermissions(sessionId: string): Readonly<PermissionsConfig> {
    return this.withResourceFolders(this.getBaseEffectivePermissions(sessionId));
  }

  private getBaseEffectivePermissions(sessionId: string): Readonly<PermissionsConfig> {
    const entity = this.entitySessionPermissions.get(sessionId);
    if (entity) return entity;

    const global = this.getPermissions();
    const adds = this.sessionAdditions.get(sessionId);
    if (!adds) return global;
    const allowAdds = adds.allow.filter((p) => !global.allow.includes(p));
    return {
      ...global,
      allow: allowAdds.length ? [...global.allow, ...allowAdds] : global.allow,
      tools: Object.keys(adds.tools).length > 0 ? { ...global.tools, ...adds.tools } : global.tools,
      allowedReadFolders: adds.readFolders.length
        ? [...(global.allowedReadFolders ?? []), ...adds.readFolders]
        : global.allowedReadFolders,
      allowedWriteFolders: adds.writeFolders.length
        ? [...(global.allowedWriteFolders ?? []), ...adds.writeFolders]
        : global.allowedWriteFolders,
    };
  }

  /** Merge the static resource roots into read+write grants so skill/automation
   *  resource dirs stay accessible to the self-tools without a card. Stripped
   *  under tenant restrictToWorkspace — applied here, after the per-session
   *  merge, so it covers entity (automation/heartbeat) sessions too. */
  private withResourceFolders(perms: Readonly<PermissionsConfig>): Readonly<PermissionsConfig> {
    if (this.deps.tenantPolicy?.get()?.restrictToWorkspace) return perms;
    const roots = this.deps.getResourceFolderRoots?.() ?? [];
    if (roots.length === 0) return perms;
    return {
      ...perms,
      allowedReadFolders: [...(perms.allowedReadFolders ?? []), ...roots],
      allowedWriteFolders: [...(perms.allowedWriteFolders ?? []), ...roots],
    };
  }

  /**
   * Persist an "Always allow" rule to the permissions block on disk.
   * Shell commands save the extracted pattern; other kinds save the pattern key.
   *
   * When the session has registered entity permissions (automation/heartbeat),
   * the rule is saved to the entity's config via the persist callback.
   * Otherwise it is saved to global settings.
   */
  private persistAllowRule(request: ApprovalRequest): boolean {
    const entityPerms = this.entitySessionPermissions.get(request.sessionId);
    const persistToEntity = this.entitySessionCallbacks.get(request.sessionId);
    const base = entityPerms ?? this.getPermissions();
    const updated = structuredClone(base);

    // Empty allowlist: classify structurally without regard to existing exceptions —
    // the gate already filtered live allowedSensitivePaths before this "Always allow" fired.
    const sensitiveHit = checkSensitivePath(request, []);
    if (sensitiveHit) {
      const alreadyAllowed = updated.allowedSensitivePaths?.includes(sensitiveHit.resolvedPath);
      if (alreadyAllowed) return false;
      updated.allowedSensitivePaths = [
        ...(updated.allowedSensitivePaths ?? []),
        sensitiveHit.resolvedPath,
      ];
    } else {
      const changed = this.addApprovalToConfig(updated, request);
      // Skip write if addApprovalToConfig was a no-op (empty command, wildcard, duplicate).
      // Trust the boolean — key-count/array-length deltas miss the `tools[key]: false→true`
      // flip, which is a real change that must persist.
      if (!changed) return false;
    }

    if (entityPerms && persistToEntity) {
      this.entitySessionPermissions.set(request.sessionId, updated);
      persistToEntity(updated);
    } else {
      this.deps.settingsManager.update({
        ...this.deps.settingsManager.get(),
        permissions: updated,
      });
    }

    // Notify so any sibling pending requests in the same session that
    // the new rule now matches can be auto-resolved. Scoped to
    // request.sessionId — entity rules MUST NOT leak across sessions.
    try {
      this.onAlwaysAllowAddedCallback?.(request.sessionId);
    } catch (err) {
      // Defensive: never let a downstream listener crash the rule write.
      log.warn("onAlwaysAllowAdded listener threw:", err);
    }
    return true;
  }

  private isOutsideWorkspace(request: ApprovalRequest): boolean {
    const ws = this.getWorkspaceDirForSession(request.sessionId);
    const p = "path" in request ? request.path : undefined;
    if (!ws || !p) return false;
    // includeSelf so the workspace root itself counts as inside (matches
    // isPathUnderAnyDir) and never routes to a folder grant.
    return !isPathWithinDir(p, ws, { includeSelf: true });
  }

  private getWorkspaceDirForSession(sessionId: string): string | undefined {
    const scopedRoot = this.deps.getWorkspaceRootForSession?.(sessionId);
    if (scopedRoot) return scopedRoot;
    if (this.deps.hasWorkspaceScopeForSession?.(sessionId)) return undefined;
    return this.deps.workspaceDir;
  }

  private isWorkspaceScopeUnavailable(sessionId: string): boolean {
    return (
      this.deps.hasWorkspaceScopeForSession?.(sessionId) === true &&
      !this.deps.getWorkspaceRootForSession?.(sessionId)
    );
  }

  private recordFolderGrant(action: PermissionAction, request: ApprovalRequest): boolean {
    if (action !== "allow-session" && action !== "always-allow") return false;
    const p = "path" in request ? request.path : undefined;
    if (!p) return false;
    const folder = grantFolderForPath(p);
    const key: "allowedReadFolders" | "allowedWriteFolders" =
      request.kind === "write" ? "allowedWriteFolders" : "allowedReadFolders";

    if (action === "always-allow") {
      return this.persistFolderGrant(key, folder, request.sessionId);
    }

    // allow-session. Entity sessions (automation/heartbeat) carry a full config
    // that getEffectivePermissions returns directly, so the grant must live on
    // that config — mirroring how addApprovalToConfig handles allow-session.
    // Non-entity sessions use the sessionAdditions overlay.
    const entityConfig = this.entitySessionPermissions.get(request.sessionId);
    if (entityConfig) {
      const current = entityConfig[key] ?? [];
      if (current.includes(folder)) return false;
      entityConfig[key] = [...current, folder];
      return true;
    }

    let adds = this.sessionAdditions.get(request.sessionId);
    if (!adds) {
      adds = { allow: [], tools: {}, readFolders: [], writeFolders: [] };
      this.sessionAdditions.set(request.sessionId, adds);
    }
    const list = key === "allowedWriteFolders" ? adds.writeFolders : adds.readFolders;
    if (list.includes(folder)) return false;
    list.push(folder);
    return true;
  }

  private persistFolderGrant(
    key: "allowedReadFolders" | "allowedWriteFolders",
    folder: string,
    sessionId: string,
  ): boolean {
    const entityPerms = this.entitySessionPermissions.get(sessionId);
    const persistToEntity = this.entitySessionCallbacks.get(sessionId);
    const base = entityPerms ?? this.getPermissions();
    const current = base[key] ?? [];
    if (current.includes(folder)) return false;

    const updated = structuredClone(base);
    updated[key] = [...current, folder];

    if (entityPerms && persistToEntity) {
      this.entitySessionPermissions.set(sessionId, updated);
      persistToEntity(updated);
    } else {
      // An entity session without an onPersist callback would write to global here.
      // Unreachable in practice — registerSessionPermissions pairs entity configs
      // with setDenyPrompt — and matches persistAllowRule's fallback shape.
      this.deps.settingsManager.update({
        ...this.deps.settingsManager.get(),
        permissions: updated,
      });
    }
    try {
      this.onAlwaysAllowAddedCallback?.(sessionId);
    } catch (err) {
      log.warn("onAlwaysAllowAdded listener threw:", err);
    }
    return true;
  }

  /** Register per-entity permissions for a session (full replacement for global).
   *  @param onPersist — called when "Always allow" updates the entity permissions,
   *  so the caller can persist the updated config to disk (automation JSON / heartbeat settings).
   *  When omitted, an "always-allow" click in this session writes to global
   *  while the entity entry stays unchanged — meaning subsequent evaluations
   *  in this session will still see the stale entity config. Callers that
   *  skip onPersist (today: AI-investigator) MUST also call setDenyPrompt
   *  on the same session so always-allow can never fire. */
  registerSessionPermissions(
    sessionId: string,
    permissions: PermissionsConfig,
    /** Called when the policy persists a rule change. May fire immediately on
     *  registration if legacy first-party tool keys are migrated. */
    onPersist?: (updated: PermissionsConfig) => void,
  ): void {
    // Per-entity configs (automations / heartbeat / AI-investigator) persist
    // their own PermissionsConfig outside global settings, so they don't pass
    // through the global settings migration. Migrate per-entity permissions
    // as well so old
    // automation and proactive-loop approvals match the canonical tool API.
    const keyMigration = migrateToolPermissionKeys(permissions);
    const needsAllowPromotion = keyMigration.perms.allow.some(
      (entry) => entry.startsWith("tool:") || entry.startsWith("mcp:"),
    );
    const migrated = needsAllowPromotion
      ? migrateToolsFromAllow(keyMigration.perms)
      : keyMigration.perms;
    const changed = keyMigration.changed || needsAllowPromotion;
    this.entitySessionPermissions.set(sessionId, migrated);
    if (onPersist) {
      this.entitySessionCallbacks.set(sessionId, onPersist);
      // Self-heal: write the migrated keys back to the entity's own store so it
      // stops depending on the runtime alias (which is removable after the
      // deprecation window). Only when the migration actually rewrote a key.
      if (changed) onPersist(migrated);
    } else {
      this.entitySessionCallbacks.delete(sessionId);
    }
  }

  /**
   * Returns the registered entity-session config for automations / heartbeat /
   * AI investigator sessions only. Chat sessions ("Allow for session" clicks)
   * are stored as diff overlays in sessionAdditions and are NOT returned here —
   * call getEffectivePermissions for the composed result.
   *
   * Used by SessionManager.buildSystemMessage so the system prompt's
   * disabled-server gating stays in sync with what the pre-hook will actually
   * deny — e.g. an automation that scopes Browser Control off only for its
   * own runs gets a prompt without the Browser Control section.
   */
  getSessionPermissions(sessionId: string): PermissionsConfig | undefined {
    return this.entitySessionPermissions.get(sessionId);
  }

  /** Unregister per-entity permissions for a session (reverts to global).
   *  Also clears the unattended flag — callers that call clearUnattended separately are double-deleting (harmless). */
  unregisterSessionPermissions(sessionId: string): void {
    this.entitySessionPermissions.delete(sessionId);
    this.entitySessionCallbacks.delete(sessionId);
    this.unattendedSessions.delete(sessionId);
  }

  /** Clear session-scoped permissions (called on session delete). */
  clearSession(sessionId: string): void {
    this.entitySessionPermissions.delete(sessionId);
    this.entitySessionCallbacks.delete(sessionId);
    this.sessionDenyPrompt.delete(sessionId);
    this.sessionAdditions.delete(sessionId);
    this.sessionMcpScope.delete(sessionId);
    this.unattendedSessions.delete(sessionId);
  }

  /** Clear all session-scoped permissions (called on delete-all). */
  clearAll(): void {
    this.entitySessionPermissions.clear();
    this.entitySessionCallbacks.clear();
    this.sessionDenyPrompt.clear();
    this.sessionAdditions.clear();
    this.sessionMcpScope.clear();
    this.unattendedSessions.clear();
  }

  /**
   * Per-session MCP allowlist (R1-FIXES A13). When `allowedKeys` is null
   * the session clears its scope and falls back to the global MCP set.
   * When `allowedKeys` is `[]`, every MCP tool call in this session is
   * denied pre-hook. Otherwise only tools whose configKey prefix matches
   * an entry in the list are allowed; the rest are denied with a
   * "scoped by workflow" reason.
   *
   * Keys are normalized to lowercase to mirror the boundary match in
   * `checkUserDisabledTool` (custom-server keys are lowercased at
   * `toMcpServerKey` write time; built-in keys are already lowercase).
   *
   * Idempotent — re-setting the same scope is a no-op from the caller's
   * perspective; the underlying Map.set is cheap.
   */
  setSessionMcpScope(sessionId: string, allowedKeys: readonly string[] | null): void {
    if (allowedKeys === null) {
      this.sessionMcpScope.delete(sessionId);
      return;
    }
    const known = new Set((this.deps.getKnownMcpKeys?.() ?? []).map((key) => key.toLowerCase()));
    const normalized = new Set<string>();
    for (const rawKey of allowedKeys) {
      const key = toMcpServerKey(rawKey);
      if (!key) continue;
      normalized.add(key);
      if (key.endsWith("-mcp")) {
        const withoutSuffix = key.slice(0, -"-mcp".length);
        if (known.has(withoutSuffix)) normalized.add(withoutSuffix);
      }
    }
    this.sessionMcpScope.set(sessionId, normalized);
  }

  /** Returns the per-session MCP scope or undefined (no override). Empty
   *  set is meaningful — "block every MCP server". */
  getSessionMcpScope(sessionId: string): ReadonlySet<string> | undefined {
    return this.sessionMcpScope.get(sessionId);
  }

  /** Register a callback for when a deny-prompt session has a tool blocked. */
  onDenyPrompt(cb: (sessionId: string, kind: string, detail: string) => void): void {
    this.onDenyPromptCallback = cb;
  }

  /** Mark a session as deny-prompt — tool calls that would prompt are auto-denied. */
  setDenyPrompt(sessionId: string): void {
    this.sessionDenyPrompt.add(sessionId);
  }

  /** Remove deny-prompt mode for a session. */
  clearDenyPrompt(sessionId: string): void {
    this.sessionDenyPrompt.delete(sessionId);
  }

  /** Mark a session as running unattended — tool auto-approve uses the stricter unattended-safe set.
   *  Not on IPermissionPolicy — callers that need it hold the concrete PermissionPolicy directly. */
  markUnattended(sessionId: string): void {
    this.unattendedSessions.add(sessionId);
  }

  /** Remove unattended mode for a session. */
  clearUnattended(sessionId: string): void {
    this.unattendedSessions.delete(sessionId);
  }

  /**
   * Match a tool name against the per-session MCP allowlist (R1-FIXES A13).
   * Returns the deny reason string (the configKey display name) when the
   * tool belongs to a known MCP server that is NOT in the session's scope.
   * Returns null when the session has no scope, when the tool isn't an MCP
   * tool, or when the tool's MCP server is in scope.
   *
   * Mirrors the boundary match used by `checkUserDisabledTool` (longest-key
   * first; exact / `__` / `-` boundaries) so a custom server `play` cannot
   * shadow built-in `playwright` regardless of caller iteration order.
   *
   * Non-MCP tool calls (first-party tools, shell, and web search)
   * never match because their prefixes are not in the MCP universe.
   */
  private checkSessionScopedMcp(sessionId: string, toolName: string): string | null {
    const scope = this.sessionMcpScope.get(sessionId);
    if (!scope) return null;
    const known = this.deps.getKnownMcpKeys?.() ?? [];
    if (known.length === 0) return null;
    const tl = toolName.toLowerCase();
    const sorted = [...known].sort((a, b) => b.length - a.length);
    for (const key of sorted) {
      if (!key) continue;
      const k = key.toLowerCase();
      if (tl === k || tl.startsWith(`${k}__`) || tl.startsWith(`${k}-`)) {
        // Tool belongs to MCP server `key`. Allow iff the scope contains it.
        if (scope.has(k)) return null;
        return CONFIG_KEY_TO_DISPLAY_NAME[key] ?? key;
      }
    }
    // Tool doesn't match any known MCP key → not an MCP tool → out of scope.
    return null;
  }
}
