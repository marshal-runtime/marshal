import path from "node:path";

import { resolveWorktreesDir } from "./persisted-paths";

export function resolveWorktreeRoot(appDataDir: string, configuredDir?: string): string {
  const configured = configuredDir?.trim();
  return configured ? path.resolve(configured) : resolveWorktreesDir(appDataDir);
}
