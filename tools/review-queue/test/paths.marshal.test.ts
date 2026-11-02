import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  resolveBase,
  socketPath,
  reviewsDir,
  statusPath,
  statePath,
  daemonLogPath,
  daemonPidPath,
  reviewFilePath,
} from "../src/marshal-review-paths.ts";

const ORIGINAL_ENV = { ...process.env };

describe("paths", () => {
  beforeEach(() => {
    delete process.env.MARSHAL_REVIEW_QUEUE_HOME;
    delete process.env.MARSHAL_REVIEW_QUEUE_SOCKET;
    delete process.env.MARSHAL_REVIEW_QUEUE_HOME;
    delete process.env.MARSHAL_REVIEW_QUEUE_SOCKET;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults base to ~/.marshal-review-queue", () => {
    expect(resolveBase()).toBe(path.join(os.homedir(), ".marshal-review-queue"));
  });

  it("respects MARSHAL_REVIEW_QUEUE_HOME override", () => {
    process.env.MARSHAL_REVIEW_QUEUE_HOME = "/tmp/foo";
    expect(resolveBase()).toBe("/tmp/foo");
  });

  it("accepts the legacy MARSHAL_REVIEW_QUEUE_HOME override", () => {
    process.env.MARSHAL_REVIEW_QUEUE_HOME = "/tmp/legacy";
    expect(resolveBase()).toBe("/tmp/legacy");
  });

  it("derives reviews/status/state/log/pid paths from base", () => {
    process.env.MARSHAL_REVIEW_QUEUE_HOME = "/tmp/foo";
    expect(reviewsDir()).toBe(path.join("/tmp/foo", "reviews"));
    expect(statusPath()).toBe(path.join("/tmp/foo", "status.md"));
    expect(statePath()).toBe(path.join("/tmp/foo", "state.json"));
    expect(daemonLogPath()).toBe(path.join("/tmp/foo", "daemon.log"));
    expect(daemonPidPath()).toBe(path.join("/tmp/foo", "daemon.pid"));
    expect(reviewFilePath(1147)).toBe(path.join("/tmp/foo", "reviews", "pr-1147.md"));
  });

  it("derives socket path: POSIX uses base/daemon.sock, Windows uses named pipe", () => {
    process.env.MARSHAL_REVIEW_QUEUE_HOME = "/tmp/foo";
    if (process.platform === "win32") {
      expect(socketPath()).toBe("\\\\.\\pipe\\marshal-review-queue");
    } else {
      expect(socketPath()).toBe(path.join("/tmp/foo", "daemon.sock"));
    }
  });

  it("respects MARSHAL_REVIEW_QUEUE_SOCKET override on all platforms", () => {
    process.env.MARSHAL_REVIEW_QUEUE_SOCKET = "/tmp/custom.sock";
    expect(socketPath()).toBe("/tmp/custom.sock");
  });
});
