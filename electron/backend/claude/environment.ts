import os from "node:os";
import path from "node:path";

import { GIT_SAFE_ALIAS_SUBCOMMANDS } from "../../permission-policy";

export const DEFAULT_CLAUDE_CONFIG_DIR = path.join(os.homedir(), ".marshal", "marshal-claude");

export type ClaudeEnvironment = Record<string, string | undefined>;

let hostConfigDir: string | undefined;

export function readClaudeEnvironmentVariable(
  env: ClaudeEnvironment,
  name: string,
): string | undefined {
  const exact = env[name];
  if (exact !== undefined || process.platform !== "win32") return exact;
  const normalizedName = name.toUpperCase();
  const matchedName = Object.keys(env).find(
    (candidate) => candidate.toUpperCase() === normalizedName,
  );
  return matchedName ? env[matchedName] : undefined;
}

export function deleteClaudeEnvironmentVariable(env: ClaudeEnvironment, name: string): void {
  const normalizedName = name.toUpperCase();
  for (const candidate of Object.keys(env)) {
    if (candidate.toUpperCase() === normalizedName) delete env[candidate];
  }
}

export function configureClaudeSdkHostEnvironment(configDir: string): string {
  const resolved = path.resolve(configDir);
  const comparisonKey = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (hostConfigDir && hostConfigDir !== comparisonKey) {
    throw new Error(`Claude Agent SDK is already configured with a different CLAUDE_CONFIG_DIR`);
  }

  // The SDK's standalone history/delete helpers read and memoize this value in
  // the host process, while query() also forwards it to the CLI subprocess.
  hostConfigDir = comparisonKey;
  process.env.CLAUDE_CONFIG_DIR = resolved;
  return resolved;
}

export function createClaudeEnvironment(
  source: ClaudeEnvironment,
  options: { configDir?: string; clientName?: string } = {},
): ClaudeEnvironment {
  const env = { ...source };
  for (const name of [
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_NO_ASAR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "GIT_EXTERNAL_DIFF",
    "GIT_EDITOR",
    "GIT_ASKPASS",
  ]) {
    deleteClaudeEnvironmentVariable(env, name);
  }
  for (const name of Object.keys(env)) {
    const normalizedName = name.toUpperCase();
    if (
      /^CLAUDE_CODE_(?:.*OAUTH.*|.*HOST_AUTH.*|.*AUTH_FILE_DESCRIPTOR.*|API_KEY_FILE_DESCRIPTOR|ENABLE_PROXY_AUTH_HELPER|SUBSCRIPTION_TYPE)$/.test(
        normalizedName,
      )
    ) {
      delete env[name];
    }
  }
  env.GIT_PAGER = "";
  env.GIT_TERMINAL_PROMPT = "0";
  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name.toUpperCase())) delete env[name];
  }
  GIT_SAFE_ALIAS_SUBCOMMANDS.forEach((subcommand, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = `alias.${subcommand}`;
    env[`GIT_CONFIG_VALUE_${index}`] = subcommand;
  });
  env.GIT_CONFIG_COUNT = String(GIT_SAFE_ALIAS_SUBCOMMANDS.length);

  env.CLAUDE_CONFIG_DIR = options.configDir ?? DEFAULT_CLAUDE_CONFIG_DIR;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = options.clientName ?? "marshal";
  return env;
}

export function isTruthyEnvironmentFlag(value: string | undefined): boolean {
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
