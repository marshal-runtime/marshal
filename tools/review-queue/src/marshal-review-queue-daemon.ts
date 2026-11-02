import fs from "node:fs/promises";

import lockfile from "proper-lockfile";

import { makeRouter } from "./marshal-review-daemon-router.ts";
import { runDashboard } from "./marshal-review-dashboard.ts";
import { startHttpServer } from "./marshal-review-http-server.ts";
import { Orchestrator } from "./marshal-review-orchestrator.ts";
import { socketPath, daemonPidPath, resolveBase, daemonLogPath } from "./marshal-review-paths.ts";
import { StateStore } from "./marshal-review-state-store.ts";

async function main(): Promise<void> {
  await fs.mkdir(resolveBase(), { recursive: true });

  const pidPath = daemonPidPath();

  // Ensure the lockfile target exists (`proper-lockfile` requires the file).
  // If a stale pid file is here from a prior unclean shutdown, we use its
  // contents only to detect a conflicting live process — we do NOT overwrite
  // it until we own the lock.
  try {
    await fs.access(pidPath);
  } catch {
    await fs.writeFile(pidPath, "{}");
  }

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(pidPath, { retries: 0 });
  } catch {
    // proper-lockfile failed — could mean another daemon holds the lock, or
    // the fs doesn't support the lock type. Fall back to a process-alive
    // check using whatever pid the existing file claims. CRITICAL: don't
    // touch the pid file in this branch — the other daemon may still be
    // alive and own it.
    let conflicting = false;
    try {
      const raw = await fs.readFile(pidPath, "utf8");
      const existing: unknown = JSON.parse(raw);
      const existingPid =
        typeof existing === "object" &&
        existing !== null &&
        "pid" in existing &&
        typeof existing.pid === "number"
          ? existing.pid
          : undefined;
      if (existingPid !== undefined && existingPid !== process.pid) {
        try {
          process.kill(existingPid, 0);
          conflicting = true;
        } catch {
          // ESRCH — process is gone; safe to proceed past the lock failure
        }
      }
    } catch {
      // unreadable / empty pid file — treat as no conflict
    }
    if (conflicting) {
      process.stderr.write(
        `marshal-review-queue: another daemon is running (lock held on ${pidPath}). Run \`marshal-review-queue stop\`.\n`,
      );
      process.exit(2);
    }
  }

  // We own the lock (or the prior holder is dead). Safe to write our identity.
  await fs.writeFile(
    pidPath,
    JSON.stringify(
      { pid: process.pid, startedAt: new Date().toISOString(), socketPath: socketPath() },
      null,
      2,
    ),
  );

  const store = await StateStore.create();
  const orch = new Orchestrator({
    store,
    runDashboard: async () => {
      const repos = store.snapshot().config.repos;
      const repo = repos.default;
      if (!repo) {
        throw new Error(
          `no \`default\` repo in config.repos. Found keys: [${Object.keys(repos).join(", ") || "(none)"}]. ` +
            `Multi-repo isn't supported yet; populate config.repos.default in state.json.`,
        );
      }
      return await runDashboard(repo);
    },
  });

  const log = await fs.open(daemonLogPath(), "a");
  const logLine = (line: string): void => {
    // Fire-and-forget — log writes shouldn't block request handling. The handle
    // is opened in append mode so concurrent writes from multiple callbacks are
    // serialized by the kernel.
    void log.write(line.endsWith("\n") ? line : line + "\n");
  };

  const router = makeRouter({ store, orch, onLog: logLine });
  const server = await startHttpServer({ socketPath: socketPath(), router, onError: logLine });

  logLine(`[${new Date().toISOString()}] daemon started, pid=${process.pid}, sock=${socketPath()}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await log.write(`[${new Date().toISOString()}] shutdown initiated (${signal})\n`);
    await orch.cancelAll();
    await server.close();
    await log.close();
    if (release) await release().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(
    `marshal-review-queue daemon fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
