/**
 * Lean-prompt flags. Three independent experiments, each Claude-runtime only:
 *
 * - `leanPrompt` (env `MARSHAL_LEAN_PROMPT`): stage A — trimmed claude-tooling,
 *   host-tools and runtime sections, the lean-only skills index entry, and the
 *   trimmed native tool list.
 * - `leanRepoRules` (env `MARSHAL_LEAN_REPO_RULES`): forward an index (not the
 *   bodies) of large always-apply repository rule files and omit duplicates.
 * - `leanCore` (env `MARSHAL_LEAN_CORE`): stage B — the rewritten behavior core
 *   (plus deeper de-duplication of the other sections when `leanPrompt` is on).
 *
 * Every flag OFF reproduces the legacy behavior byte-for-byte (pinned by the
 * golden fixtures in `prompt/golden/`). The decision is made when a session is
 * created and stamped on the session; only `MARSHAL_LEAN_*=0` also reverts
 * sessions that already exist.
 */

export const LEAN_PROMPT_ENV_VAR = "MARSHAL_LEAN_PROMPT";
export const LEAN_REPO_RULES_ENV_VAR = "MARSHAL_LEAN_REPO_RULES";
export const LEAN_CORE_ENV_VAR = "MARSHAL_LEAN_CORE";

/** Native Claude Code tools that duplicate Marshal host tools (askUser, workflow*). */
export const LEAN_PROMPT_DISABLED_NATIVE_TOOLS: readonly string[] = ["AskUserQuestion", "Workflow"];

/** Bundled skills advertised only in lean prompts (the legacy prompt carries their content inline). */
export const LEAN_ONLY_SKILL_NAMES: readonly string[] = ["runtime-ui-authoring"];

type LeanPromptEnv = Readonly<Record<string, string | undefined>>;

function parseFlagEnv(envVar: string, env: LeanPromptEnv): boolean | undefined {
  const raw = env[envVar]?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return undefined;
}

/** Value to stamp on a session being created: env override, else the setting, default ON. */
function resolveForNewSession(
  envVar: string,
  setting: boolean | undefined,
  env: LeanPromptEnv,
): boolean {
  return parseFlagEnv(envVar, env) ?? setting ?? true;
}

/** Whether an existing session applies a flag: its stamp, unless the env kill switch is 0. */
function isSessionFlagOn(envVar: string, stamp: boolean | undefined, env: LeanPromptEnv): boolean {
  if (parseFlagEnv(envVar, env) === false) return false;
  return stamp === true;
}

export function resolveLeanPromptForNewSession(
  setting: boolean | undefined,
  env: LeanPromptEnv = process.env,
): boolean {
  return resolveForNewSession(LEAN_PROMPT_ENV_VAR, setting, env);
}

export function isLeanPromptSession(
  stamp: boolean | undefined,
  env: LeanPromptEnv = process.env,
): boolean {
  return isSessionFlagOn(LEAN_PROMPT_ENV_VAR, stamp, env);
}

export function resolveLeanRepoRulesForNewSession(
  setting: boolean | undefined,
  env: LeanPromptEnv = process.env,
): boolean {
  return resolveForNewSession(LEAN_REPO_RULES_ENV_VAR, setting, env);
}

export function isLeanRepoRulesSession(
  stamp: boolean | undefined,
  env: LeanPromptEnv = process.env,
): boolean {
  return isSessionFlagOn(LEAN_REPO_RULES_ENV_VAR, stamp, env);
}

export function resolveLeanCoreForNewSession(
  setting: boolean | undefined,
  env: LeanPromptEnv = process.env,
): boolean {
  return resolveForNewSession(LEAN_CORE_ENV_VAR, setting, env);
}

export function isLeanCoreSession(
  stamp: boolean | undefined,
  env: LeanPromptEnv = process.env,
): boolean {
  return isSessionFlagOn(LEAN_CORE_ENV_VAR, stamp, env);
}
