// Marshal-owned module.
import type { AgentRuntime } from "../types.ts";
import { claudeSpawnConfig } from "./claude.ts";
import { copilotSpawnConfig } from "./copilot.ts";

export type SpawnConfigOpts = {
  cwd: string;
};

export type SpawnConfig = {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Adapter-specific metadata forwarded as `_meta` on ACP `session/new`.
   *  Claude adapter uses this to pass `managedSettings.permissions.deny`
   *  through to the underlying agent SDK. Copilot ignores it. */
  sessionMeta?: Record<string, unknown>;
};

export function spawnConfigFor(runtime: AgentRuntime, opts: SpawnConfigOpts): SpawnConfig {
  switch (runtime) {
    case "claude":
      return claudeSpawnConfig(opts);
    case "copilot":
      return copilotSpawnConfig(opts);
    default: {
      // Exhaustiveness guard — fails the build if AgentRuntime gains a new
      // variant without a matching adapter. (Linter doesn't see TS's
      // discriminated-union exhaustiveness as a `return` so we make it explicit.)
      const _exhaustive: never = runtime;
      throw new Error(`unknown runtime: ${String(_exhaustive)}`);
    }
  }
}
