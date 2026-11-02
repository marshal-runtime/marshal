import { spawn } from "child_process";

import type { LocalClientSubset } from "./internal";

/** A client whose transport or process is gone; every call on it would fail, so it must be replaced. */
export function isRuntimeClientDead(client: LocalClientSubset): boolean {
  try {
    if (client.isClosed?.()) return true;
    const proc = client.process;
    return proc !== undefined && (proc.exitCode !== null || proc.killed);
  } catch {
    return false;
  }
}

export function forceKillRuntimeClient(client: LocalClientSubset): void {
  try {
    client.markForceStopping?.();
    const proc = client.process;
    // On Windows, ChildProcess.kill()/SIGKILL terminates ONLY the direct CLI
    // PID and orphans its entire descendant tree — the Copilot CLI's MCP
    // servers (playwright, custom stdio MCPs) and THEIR heavyweight
    // grandchildren.
    // On the timeout-restart path (restart() → killClientProcess, no graceful
    // client.stop()) those orphans survive every restart and accumulate into
    // thousands of processes / tens of GB (observed: 9 stale copilot.exe
    // backends holding ~800 Mashup containers, ~50GB). Force a full tree-kill
    // rooted at the tracked PID so the whole subtree dies with the backend.
    if (process.platform === "win32" && typeof proc?.pid === "number") {
      try {
        spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], {
          stdio: "ignore",
          windowsHide: true,
        }).unref();
      } catch {
        // fall through to proc.kill below
      }
    }
    if (proc && typeof proc.kill === "function") {
      proc.kill("SIGKILL");
    }
  } catch {
    // ignore — process may already be dead
  }
}
