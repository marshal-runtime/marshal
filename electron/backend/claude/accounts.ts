import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../../../common/marshal-logger";
import { isRuntimeAccountId } from "../../../common/runtime-accounts";
import { deleteClaudeEnvironmentVariable, type ClaudeEnvironment } from "./environment";

const log = createLogger("ClaudeAccounts");

/** Transcript folder every account shares, so history reads, deletes, and handoffs see all accounts. */
const SHARED_TRANSCRIPTS_DIRECTORY = "projects";

/** Launch-environment credentials outrank a config dir's login, so extra accounts drop them. */
const LAUNCH_CREDENTIAL_VARIABLES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export function withoutLaunchCredentials(env: ClaudeEnvironment): ClaudeEnvironment {
  const scoped = { ...env };
  for (const name of LAUNCH_CREDENTIAL_VARIABLES) deleteClaudeEnvironmentVariable(scoped, name);
  return scoped;
}

export function claudeAccountConfigDir(accountId: string, homeDir: string = os.homedir()): string {
  if (!isRuntimeAccountId(accountId)) throw new Error("Invalid Claude account id");
  return path.join(homeDir, ".marshal", "marshal-claude-accounts", accountId);
}

/**
 * Prepares an extra account's `CLAUDE_CONFIG_DIR`. Claude Code stores its login per config
 * directory (macOS Keychain service `Claude Code-credentials-<sha256(dir)[:8]>`, otherwise
 * `<dir>/.credentials.json`), so each directory is its own signed-in account. Transcripts are
 * linked to the host directory: the SDK's `getSessionMessages()` and `deleteSession()` read
 * the host `CLAUDE_CONFIG_DIR` only.
 */
export async function ensureClaudeAccountConfigDir(
  hostConfigDir: string,
  accountId: string,
  options: { homeDir?: string; platform?: NodeJS.Platform } = {},
): Promise<string> {
  const accountDir = claudeAccountConfigDir(accountId, options.homeDir);
  await mkdir(accountDir, { recursive: true, mode: 0o700 });
  const target = path.join(hostConfigDir, SHARED_TRANSCRIPTS_DIRECTORY);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await linkSharedDirectory(
    target,
    path.join(accountDir, SHARED_TRANSCRIPTS_DIRECTORY),
    options.platform ?? process.platform,
  );
  return accountDir;
}

async function linkSharedDirectory(
  target: string,
  link: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const existing = await lstat(link).catch(() => null);
  if (existing?.isSymbolicLink()) {
    const current = path.resolve(path.dirname(link), await readlink(link));
    if (current === path.resolve(target)) return;
    log.warn("Claude account shared directory points elsewhere; leaving it unchanged");
    return;
  }
  if (existing) {
    log.warn("Claude account has its own transcript directory; history reads cannot see it");
    return;
  }
  // Junctions need no Windows symlink privilege and are directory-only, which is all we link.
  await symlink(target, link, platform === "win32" ? "junction" : "dir");
}
