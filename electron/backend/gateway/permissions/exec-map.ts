/**
 * m's `autoApproveReadOnly` + shell `allow[]` ↔ marshal `tools.exec`.
 *
 * The two systems use different gating models:
 *   m: glob patterns over full command strings (`gh api repos/foo/*`)
 *   marshal: structured allowlist of binary names + per-binary flag rules
 *             (`tools.exec.safeBins[] + safeBinProfiles{}`)
 *
 * We only translate the binary-name subset of m's patterns. Patterns
 * with whitespace or globs are flagged as "rejected" (returned to the
 * caller for warning-chip rendering), not silently dropped.
 *
 * `denyPatterns` has no marshal counterpart and is handled by the
 * `controllable.shellDeny: false` flag at the UI layer.
 */

export type ExecAsk = "off" | "on-miss" | "always";
export type ExecSecurity = "deny" | "allowlist" | "full";

export interface ToolExecConfig {
  ask?: ExecAsk;
  security?: ExecSecurity;
  safeBins?: string[];
}

const SHELL_PATTERN_INVALID = /[\s*?]/;

export function execToAutoApproveReadOnly(exec: ToolExecConfig | undefined): boolean {
  return exec?.ask === "on-miss";
}

export function buildExecPatchFromAutoApprove(value: boolean): Partial<ToolExecConfig> {
  if (value) return { ask: "on-miss", security: "allowlist" };
  return { ask: "always" };
}

export function isShellPatternRepresentable(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return false;
  return !SHELL_PATTERN_INVALID.test(trimmed);
}

export function execToShellAllow(exec: ToolExecConfig | undefined): string[] {
  return exec?.safeBins ?? [];
}

export function buildExecPatchFromShellAllow(patterns: string[]): {
  patch: Partial<ToolExecConfig>;
  rejected: string[];
} {
  const safeBins: string[] = [];
  const rejected: string[] = [];
  for (const p of patterns) {
    if (isShellPatternRepresentable(p)) safeBins.push(p);
    else rejected.push(p);
  }
  return { patch: { safeBins }, rejected };
}
