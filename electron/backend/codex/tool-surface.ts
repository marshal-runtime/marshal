import type { UnknownRecord } from "./protocol";

/**
 * Tools Codex does not load into every request: it must be told a namespace
 * for them (deferred tools are rejected without one), and the model finds them
 * through Codex's own `tool_search`, which returns the namespaced spec; calls
 * then arrive as `item/tool/call` with this namespace (verified against
 * codex-cli 0.146.0-alpha.10.1 with a scripted Responses server).
 */
export const CODEX_DEFERRED_TOOL_NAMESPACE = "marshal_host_tools";

/** Allowlist entries that grant Codex's native shell (Claude-style and Codex names). */
const SHELL_TOOL_NAMES = new Set([
  "Bash",
  "BashOutput",
  "KillShell",
  "shell",
  "shell_command",
  "exec_command",
  "write_stdin",
  "local_shell",
]);
const WEB_SEARCH_TOOL_NAMES = new Set(["WebSearch", "WebFetch", "web_search"]);

export interface CodexNativeTools {
  readonly shell: boolean;
  readonly webSearch: boolean;
}

/**
 * Native Codex tools a session may use under `RuntimeSessionConfig.availableTools`.
 * `undefined` is unrestricted. A list grants only the native tools it names;
 * host tools ride `dynamicTools`, which the session builder already narrows.
 * `apply_patch` and `view_image` cannot be removed through Config (verified
 * against codex-cli 0.146.0-alpha.10.1: every request still carries them), so
 * for restricted sessions the permission policy denies them instead.
 */
export function resolveCodexNativeTools(
  availableTools: readonly string[] | undefined,
): CodexNativeTools {
  if (availableTools === undefined) return { shell: true, webSearch: true };
  return {
    shell: availableTools.some((name) => SHELL_TOOL_NAMES.has(name)),
    webSearch: availableTools.some((name) => WEB_SEARCH_TOOL_NAMES.has(name)),
  };
}

/**
 * Config overrides for thread/start and thread/resume. Keys verified against
 * the pinned binary with a mock Responses server: `features.shell_tool` drops
 * exec_command/write_stdin, `features.goals` drops the native goal tools,
 * `web_search = "disabled"` drops web_search, `tools.update_plan.enabled` and
 * `tools.experimental_request_user_input.enabled` drop those tools, and
 * `features.multi_agent` drops the collaboration tool-discovery surface.
 *
 * Multi-agent v2 models (gpt-5.6-sol/terra) always get Codex's collaboration
 * tools; no config key removes them (probed on codex-cli 0.146.0-alpha.10.1).
 * An empty root hint drops the "You are `/root`, the primary agent in a team"
 * developer message, which conflicts with Marshal's own agent identity. The
 * `<multi_agent_mode>` hint stays: it is the guard that tells the model not to
 * spawn native sub-agents unless asked.
 */
export function toCodexToolSurfaceConfig(
  availableTools: readonly string[] | undefined,
): UnknownRecord {
  const native = resolveCodexNativeTools(availableTools);
  // Marshal owns goals (goalSet and friends); Codex's own goal tools would let
  // the model start continuation turns the host does not track.
  const features: UnknownRecord = {
    goals: false,
    multi_agent_v2: { root_agent_usage_hint_text: "" },
  };
  if (availableTools === undefined) return { features };
  features["shell_tool"] = native.shell;
  features["multi_agent"] = false;
  return {
    features,
    ...(native.webSearch ? {} : { web_search: "disabled" }),
    tools: {
      update_plan: { enabled: false },
      experimental_request_user_input: { enabled: false },
    },
  };
}
