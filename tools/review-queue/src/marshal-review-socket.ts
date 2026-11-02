// Marshal-owned module.
import fs from "node:fs/promises";

/** POSIX-only: remove a stale socket file before binding. No-op on Windows. */
export async function unlinkStaleSocket(socketPath: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await fs.unlink(socketPath);
  } catch (err: unknown) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
  }
}
