import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { httpRequest } from "../src/marshal-review-http-client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonEntry = path.resolve(__dirname, "../src/marshal-review-queue-daemon.ts");

let tmp: string;
let child: ChildProcess | null = null;
let secondChild: ChildProcess | null = null;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rq-proc-"));
});

async function awaitExit(proc: ChildProcess, timeoutMs = 1000): Promise<void> {
  if (proc.killed) return;
  const exited = new Promise<void>((r) => proc.once("close", () => r()));
  proc.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}

afterEach(async () => {
  // Await the child's exit before removing the tmp dir — otherwise we race
  // the daemon's socket unlink (POSIX) or its still-held lockfile (Windows
  // EBUSY, silently swallowed by `force: true`).
  if (secondChild) await awaitExit(secondChild);
  if (child) await awaitExit(child);
  child = null;
  secondChild = null;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("daemon process", () => {
  it("starts, writes pid file, responds to /status, exits cleanly on SIGTERM", async () => {
    // Use a per-test socket so we don't collide with any real running daemon
    const sock =
      process.platform === "win32"
        ? `\\\\.\\pipe\\m-rq-test-${process.pid}-${Date.now()}`
        : path.join(tmp, "daemon.sock");

    const proc = spawn(process.execPath, [daemonEntry], {
      env: {
        ...process.env,
        MARSHAL_REVIEW_QUEUE_HOME: tmp,
        MARSHAL_REVIEW_QUEUE_SOCKET: sock,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;

    // Wait up to 8s for the daemon to come online — sequential probe is the
    // point, not a parallel hammer.
    const start = Date.now();
    let ready = false;
    while (Date.now() - start < 8000) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        const r = await httpRequest({ socketPath: sock, method: "GET", path: "/status" });
        if (r.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    expect(ready).toBe(true);

    const pidRaw = await fs.readFile(path.join(tmp, "daemon.pid"), "utf8");
    const pidJson = JSON.parse(pidRaw);
    expect(typeof pidJson.pid).toBe("number");
    expect(pidJson.pid).toBeGreaterThan(0);
    expect(pidJson.socketPath).toBe(sock);

    const exited = new Promise<number | null>((resolve) =>
      proc.on("exit", (code) => resolve(code)),
    );
    proc.kill("SIGTERM");
    const code = await exited;
    expect([0, null]).toContain(code);
  }, 15_000);

  it("rejects a second daemon targeting the same home with exit code 2", async () => {
    const sock =
      process.platform === "win32"
        ? `\\\\.\\pipe\\m-rq-test-conflict-${process.pid}-${Date.now()}`
        : path.join(tmp, "daemon.sock");
    const env = {
      ...process.env,
      MARSHAL_REVIEW_QUEUE_HOME: tmp,
      MARSHAL_REVIEW_QUEUE_SOCKET: sock,
    };

    // First daemon — wait until it owns the lock + socket.
    child = spawn(process.execPath, [daemonEntry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const start = Date.now();
    let ready = false;
    while (Date.now() - start < 8000) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        const r = await httpRequest({ socketPath: sock, method: "GET", path: "/status" });
        if (r.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    expect(ready).toBe(true);

    // Second daemon — should detect the conflicting live PID via the lockfile
    // path and exit code 2 with a stderr message naming the running daemon.
    // Use a different socket so we're testing the lockfile-conflict check,
    // not socket-already-bound (which has its own error).
    const sock2 =
      process.platform === "win32"
        ? `\\\\.\\pipe\\m-rq-test-conflict2-${process.pid}-${Date.now()}`
        : path.join(tmp, "daemon2.sock");
    secondChild = spawn(process.execPath, [daemonEntry], {
      env: { ...env, MARSHAL_REVIEW_QUEUE_SOCKET: sock2 },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderrChunks: Buffer[] = [];
    secondChild.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
    const code = await new Promise<number | null>((resolve) => {
      secondChild!.once("exit", (c) => resolve(c));
    });
    const stderr = Buffer.concat(stderrChunks).toString();
    expect(code).toBe(2);
    expect(stderr).toMatch(/another daemon is running/i);
  }, 20_000);
});
