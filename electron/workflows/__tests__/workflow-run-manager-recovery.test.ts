import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkflowRunRepository } from "../repository";
import type { SpawnAdapter } from "../spawn-adapter";
import { WorkflowRunManager } from "../workflow-run-manager";
import { WorkflowScheduleStore } from "../workflow-scheduler";

let tmpRoot: string;

beforeEach(() => {
  vi.useFakeTimers();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-run-recovery-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const unusedSpawnAdapter: SpawnAdapter = {
  async spawn() {
    throw new Error("not used");
  },
  async spawnAndRun() {
    throw new Error("not used");
  },
  async send() {
    throw new Error("not used");
  },
  async waitForReply() {
    throw new Error("not used");
  },
  async sendAndCollect() {
    throw new Error("not used");
  },
  async cancel() {
    throw new Error("not used");
  },
};

describe("WorkflowRunManager boot recovery", () => {
  it("restores schedules before stale-run reconciliation and retries stale runs separately", async () => {
    const order: string[] = [];
    const repository = new WorkflowRunRepository({
      rootDir: path.join(tmpRoot, "runs"),
    });
    const markStaleAsCrashed = vi
      .spyOn(repository, "markStaleAsCrashed")
      .mockImplementationOnce(async () => {
        order.push("stale");
        throw Object.assign(new Error("sharing violation"), { code: "EACCES" });
      })
      .mockImplementationOnce(async () => {
        order.push("stale-retry");
        return [];
      });
    const scheduleStore = new WorkflowScheduleStore({
      rootDir: path.join(tmpRoot, "schedules"),
    });
    const syncManifestDefaults = vi
      .spyOn(scheduleStore, "syncManifestDefaults")
      .mockImplementation(() => order.push("scheduler"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new WorkflowRunManager({
      spawnAdapter: unusedSpawnAdapter,
      hostSessionFactory: async ({ runId }) => `host-${runId}`,
      repository,
      scheduleStore,
      loaderOverrides: {
        userRoot: path.join(tmpRoot, "workflows"),
      },
      backendOrigin: () => "copilot",
    });

    await expect(manager.bootAndReattachInflight()).resolves.toBeUndefined();

    expect(order).toEqual(["scheduler", "stale"]);
    expect(syncManifestDefaults).toHaveBeenCalledTimes(1);
    expect(markStaleAsCrashed).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(markStaleAsCrashed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(order).toEqual(["scheduler", "stale", "stale-retry"]);
    expect(markStaleAsCrashed).toHaveBeenCalledTimes(2);
    expect(syncManifestDefaults).toHaveBeenCalledTimes(1);
  });
});
