import { spawnSync } from "node:child_process";

import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

import type { RuntimeProcessHandle } from "../runtime-contract";

interface ProcessTreeKillResult {
  killed: boolean;
  error?: Error;
}

function killProcessTree(pid: number): ProcessTreeKillResult {
  if (process.platform !== "win32") return { killed: false };
  const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
    stdio: "ignore",
    windowsHide: true,
  });
  return {
    killed: result.status === 0,
    ...(result.error ? { error: result.error } : {}),
  };
}

export class ClaudeProcessRegistry {
  private readonly processes = new Set<SpawnedProcess>();
  private readonly processesBySession = new Map<string, Set<SpawnedProcess>>();

  constructor(
    private readonly killOwnedProcessTree: (pid: number) => ProcessTreeKillResult = killProcessTree,
  ) {}

  add(process: SpawnedProcess, sessionId?: string): void {
    this.processes.add(process);
    if (sessionId) {
      const owned = this.processesBySession.get(sessionId) ?? new Set<SpawnedProcess>();
      owned.add(process);
      this.processesBySession.set(sessionId, owned);
    }
    const remove = () => {
      this.processes.delete(process);
      if (!sessionId) return;
      const owned = this.processesBySession.get(sessionId);
      owned?.delete(process);
      if (owned?.size === 0) this.processesBySession.delete(sessionId);
    };
    process.once("exit", remove);
    process.once("error", remove);
  }

  forceKillSession(sessionId: string): Error[] {
    const owned = this.processesBySession.get(sessionId);
    if (!owned) return [];
    return this.forceKillProcesses(owned);
  }

  first(): RuntimeProcessHandle | undefined {
    const process = this.processes.values().next().value;
    if (!process) return undefined;
    const pidValue = Reflect.get(process, "pid");
    return {
      pid: typeof pidValue === "number" ? pidValue : undefined,
      exitCode: process.exitCode,
      killed: process.killed,
      kill: (signal?: string) =>
        process.kill(
          // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- RuntimeProcessHandle accepts the string form used by Node child processes.
          (signal ?? "SIGTERM") as NodeJS.Signals,
        ),
    };
  }

  killAll(signal: NodeJS.Signals = "SIGTERM"): Error[] {
    const errors: Error[] = [];
    for (const process of this.processes) {
      try {
        process.kill(signal);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return errors;
  }

  forceKillAll(): Error[] {
    return this.forceKillProcesses(this.processes);
  }

  private forceKillProcesses(processes: Iterable<SpawnedProcess>): Error[] {
    const errors: Error[] = [];
    for (const process of processes) {
      const pidValue = Reflect.get(process, "pid");
      const treeResult =
        typeof pidValue === "number" ? this.killOwnedProcessTree(pidValue) : { killed: false };
      if (treeResult.error) errors.push(treeResult.error);
      if (treeResult.killed) continue;
      try {
        process.kill("SIGKILL");
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return errors;
  }
}
