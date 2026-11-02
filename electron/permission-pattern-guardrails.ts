import type { CommandClassification } from "./permission-classification-contracts";
// electron/permission-pattern-guardrails.ts
import {
  isUnsafeShellSyntax,
  matchesAllowPattern,
  splitShellSegments,
} from "./permission-patterns";
import { hasRemoteAuthVector } from "./remote-auth-permission-guard";
import { getShellMode, type ShellMode } from "./shell-syntax-permission-utils";

const DENY_BINARIES = new Set(
  [
    "rm",
    "rmdir",
    "dd",
    "mkfs",
    "shred",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
    "chmod",
    "chown",
    "chgrp",
    "setfacl",
    "curl",
    "wget",
    "scp",
    "rsync",
    "nc",
    "ncat",
    "netcat",
    "ssh",
    "tar",
    "unzip",
    "zip",
    "sudo",
    "su",
    "doas",
    "kill",
    "killall",
    "pkill",
    "remove-item",
    "stop-process",
    "stop-service",
    "set-content",
    "set-itemproperty",
    "new-item",
    "invoke-expression",
    "invoke-webrequest",
    "invoke-restmethod",
  ].map((s) => s.toLowerCase()),
);

const DENY_PAIRS = new Set([
  "git push",
  "git reset",
  "git clean",
  "git rebase",
  "git checkout",
  "docker exec",
  "docker kill",
  "docker prune",
  "docker rm",
  "docker rmi",
  "docker run",
  "docker stop",
  "kubectl apply",
  "kubectl delete",
  "kubectl edit",
  "kubectl exec",
  "kubectl patch",
  "kubectl replace",
  "kubectl rollout",
  "kubectl scale",
  "terraform destroy",
  "terraform apply",
  "aws s3 rm",
  "aws s3 sync",
]);

// TODO: populate only with evidence of safe broad patterns; keep empty until then.
const SAFE_NETWORK_BINARIES: Set<string> = new Set();

function firstToken(command: string): string {
  const trimmed = command.trim();
  const space = trimmed.search(/\s/);
  return (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
}

function leadingTokens(command: string, n: number): string[] {
  return command
    .trim()
    .split(/\s+/)
    .slice(0, n)
    .map((t) => t.toLowerCase());
}

function forceNull(input: CommandClassification, ruleId: string): CommandClassification {
  return { ...input, suggestedPattern: null, patternRationale: null, guardrailRuleId: ruleId };
}

export interface GuardrailContext {
  isReadOnlyCommand?: (command: string) => boolean;
  /** Host shell flavor. Drives the shell parser so PowerShell escape syntax
   *  and scriptblock grouping don't trip the bash-only "unsafe" gate. Default
   *  resolves from `getShellMode()` (which reads `process.platform`) so any
   *  caller that doesn't care about platform branching gets the right answer
   *  automatically. */
  shellMode?: ShellMode;
}

export function applyGuardrails(
  command: string,
  input: CommandClassification,
  ctx: GuardrailContext = {},
): CommandClassification {
  const shellMode: ShellMode = ctx.shellMode ?? getShellMode();
  let current = input;
  if (ctx.isReadOnlyCommand?.(command) && current.category !== "readonly") {
    current = { ...current, category: "readonly" };
  }

  // Block wildcard generalization for remote-auth commands so
  // "Always allow" stores the exact literal instead of e.g. `Get-Content *`.
  // Runs before isUnsafeShellSyntax so `-CimSession $s` gets G_REMOTE_AUTH in
  // the audit log instead of the generic G_COMPOUND.
  if (hasRemoteAuthVector(command, shellMode)) {
    return forceNull(current, "G_REMOTE_AUTH");
  }

  const split = splitShellSegments(command, shellMode);
  if (isUnsafeShellSyntax(command, shellMode)) {
    // Unsafe shell syntax can smuggle arbitrary commands regardless of how
    // benign the outer binary looks — reject unconditionally.
    return forceNull(current, "G_COMPOUND");
  }
  if (split.segments.length > 1) {
    // Compound commands are normally too broad to generalise. Relaxation:
    // if the caller provides an isReadOnlyCommand probe AND every segment
    // individually qualifies as readonly, the compound is safe to broaden.
    // Covers the big cluster of PowerShell readonly pipelines in the audit
    // log (Get-ChildItem | Measure-Object, Get-Content | Select-String, …)
    // that were previously force-literal.
    const allReadOnly =
      ctx.isReadOnlyCommand !== undefined &&
      split.segments.every((seg) => ctx.isReadOnlyCommand!(seg));
    if (!allReadOnly) {
      return forceNull(current, "G_COMPOUND");
    }
    // Fall through: pattern continues through remaining guardrails.
  }

  if (DENY_BINARIES.has(firstToken(command))) {
    return forceNull(current, "G_DENY_BINARY");
  }

  const [t0, t1, t2] = leadingTokens(command, 3);
  if (t0 && t1) {
    const pair2 = `${t0} ${t1}`;
    const pair3 = t2 ? `${t0} ${t1} ${t2}` : "";
    if (DENY_PAIRS.has(pair2) || (pair3 && DENY_PAIRS.has(pair3))) {
      return forceNull(current, "G_DENY_PAIR");
    }
  }

  if (current.category === "destructive") {
    return forceNull(current, "G_CATEGORY_DESTRUCTIVE");
  }

  if (current.category === "network" && !SAFE_NETWORK_BINARIES.has(firstToken(command))) {
    return forceNull(current, "G_CATEGORY_NETWORK");
  }

  // Pattern sanity rules only fire when a pattern exists.
  if (current.suggestedPattern !== null) {
    const cmdFirst = firstToken(command);
    const patFirst = firstToken(current.suggestedPattern);
    if (cmdFirst !== patFirst) {
      return forceNull(current, "G_FIRST_TOKEN_MISMATCH");
    }

    // G_BARE_STAR: `<binary> *` is too broad for any binary — require at least
    // one intermediate subcommand token (e.g. `npm list *`, not `npm *`).
    // Exception: static readonly rules can confirm safety for the whole binary
    // (e.g. `ls *`) — mirrors the category-inversion invariant.
    const patternTokens = current.suggestedPattern.trim().split(/\s+/);
    const isBareStar = patternTokens.length === 2 && patternTokens[1] === "*";
    if (isBareStar && !ctx.isReadOnlyCommand?.(command)) {
      return forceNull(current, "G_BARE_STAR");
    }

    if (!matchesAllowPattern(command, current.suggestedPattern, shellMode)) {
      return forceNull(current, "G_PATTERN_MISMATCH");
    }
  }

  return current;
}
