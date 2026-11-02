import os from "node:os";
import path from "node:path";

export function resolveBase(): string {
  // Preserve the pre-rebrand override for existing local scripts.
  const override = process.env.MARSHAL_REVIEW_QUEUE_HOME ?? process.env.MARSHAL_REVIEW_QUEUE_HOME;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".marshal-review-queue");
}

export function reviewsDir(): string {
  return path.join(resolveBase(), "reviews");
}

export function reviewFilePath(prNumber: number): string {
  return path.join(reviewsDir(), `pr-${prNumber}.md`);
}

export function statusPath(): string {
  return path.join(resolveBase(), "status.md");
}

export function statePath(): string {
  return path.join(resolveBase(), "state.json");
}

export function daemonLogPath(): string {
  return path.join(resolveBase(), "daemon.log");
}

export function daemonPidPath(): string {
  return path.join(resolveBase(), "daemon.pid");
}

export function socketPath(): string {
  // Preserve the pre-rebrand override for existing local scripts.
  const override = process.env.MARSHAL_REVIEW_QUEUE_SOCKET ?? process.env.MARSHAL_REVIEW_QUEUE_SOCKET;
  if (override && override.length > 0) return override;
  if (process.platform === "win32") return "\\\\.\\pipe\\marshal-review-queue";
  return path.join(resolveBase(), "daemon.sock");
}
