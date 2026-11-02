import os from "node:os";
import path from "node:path";

export function resolveBase(): string {
  // Preserve the pre-rebrand override for existing local scripts.
  const override = process.env.MARSHAL_ACP_HOME ?? process.env.MARSHAL_ACP_HOME;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".marshal-acp");
}

export function configPath(): string {
  return path.join(resolveBase(), "config.json");
}

export function sessionsDir(): string {
  return path.join(resolveBase(), "sessions");
}

/** Accepts a basename (resolved against `sessionsDir()`) or an absolute path.
 *  `marshal-acp prompt` prints the absolute path; on Windows a `path.join(dir, abs)`
 *  would silently produce a broken hybrid. */
export function sessionFilePath(nameOrPath: string): string {
  return path.isAbsolute(nameOrPath) ? nameOrPath : path.join(sessionsDir(), nameOrPath);
}
