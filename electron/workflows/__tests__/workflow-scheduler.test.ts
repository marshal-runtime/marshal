import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { secureAtomicWriteFileSync } from "../../platform-security";
import type { InstalledWorkflowEntry } from "../workflow-loader";
import { WorkflowScheduleStore, WorkflowScheduler } from "../workflow-scheduler";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wf-schedules-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function entry(overrides: Partial<InstalledWorkflowEntry> = {}): InstalledWorkflowEntry {
  return {
    id: "test-workflow",
    key: "user-local:test-workflow",
    title: "Test workflow",
    version: "1.0.0",
    source: "user-local",
    installedAt: 1,
    distHash: "hash",
    manifest: {
      id: "test-workflow",
      version: "1.0.0",
      title: "Test workflow",
      permissions: { mode: "ask" },
      cloudSync: "inherit-host",
      notifyOnComplete: "none",
    },
    dir: tmpRoot,
    ...overrides,
  };
}

function schedulesFile(): string {
  return path.join(tmpRoot, "schedules.json");
}

function corruptScheduleArchives(): string[] {
  return fs
    .readdirSync(tmpRoot)
    .filter((name) => name.startsWith("schedules.json.corrupt-"))
    .sort();
}

describe("WorkflowScheduler", () => {
  it("persists schedules and restores them from disk", () => {
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    store.upsert({
      key: "user-local:test-workflow",
      workflowId: "test-workflow",
      naturalLanguage: "every day at 9am",
      input: { name: "Ada" },
    });

    const restored = new WorkflowScheduleStore({ rootDir: tmpRoot }).get(
      "user-local:test-workflow",
    );
    expect(restored).toMatchObject({
      workflowId: "test-workflow",
      naturalLanguage: "every day at 9am",
      enabled: true,
      input: { name: "Ada" },
    });
  });

  it.each([
    ["empty", ""],
    ["truncated", '[{"schemaVersion":1,"key":"broken"'],
    ["malformed", "{not-json"],
    ["wrong-shaped", "{}"],
  ])("archives and resets an %s schedule store once", (_kind, content) => {
    fs.writeFileSync(schedulesFile(), content, "utf-8");
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(store.list({ includeDisabled: true })).toEqual([]);

    const archives = corruptScheduleArchives();
    expect(archives).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpRoot, archives[0]), "utf-8")).toBe(content);
    expect(JSON.parse(fs.readFileSync(schedulesFile(), "utf-8"))).toEqual([]);

    expect(store.list({ includeDisabled: true })).toEqual([]);
    expect(corruptScheduleArchives()).toEqual(archives);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("repopulates manifest defaults after recovering a truncated schedule store", () => {
    fs.writeFileSync(schedulesFile(), '[{"schemaVersion":1', "utf-8");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [entry({ manifest: { ...entry().manifest, schedule: "every hour" } })],
      hasActiveRunForKey: () => false,
      runScheduledWorkflow: vi.fn<() => Promise<{ runId: string; runFamilyId: string }>>(),
    });

    scheduler.restore();

    expect(store.get("user-local:test-workflow")?.naturalLanguage).toBe("every hour");
    expect(corruptScheduleArchives()).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(schedulesFile(), "utf-8"))).toHaveLength(1);
    scheduler.stop();
  });

  it("atomically replaces an existing schedule store without leaving temporary files", () => {
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    store.upsert({
      key: "user-local:test-workflow",
      workflowId: "test-workflow",
      naturalLanguage: "every hour",
    });
    store.upsert({
      key: "user-local:second-workflow",
      workflowId: "second-workflow",
      naturalLanguage: "every day at 9am",
    });

    expect(
      new WorkflowScheduleStore({ rootDir: tmpRoot })
        .list()
        .map((record) => record.key)
        .sort(),
    ).toEqual(["user-local:second-workflow", "user-local:test-workflow"]);
    expect(fs.readdirSync(tmpRoot).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("retries quarantine on a later read after transient rename failures are exhausted", () => {
    const content = "{not-json";
    fs.writeFileSync(schedulesFile(), content, "utf-8");
    let attempts = 0;
    let busy = true;
    const renameSync: typeof fs.renameSync = (source, destination) => {
      attempts++;
      if (busy) {
        throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
      }
      fs.renameSync(source, destination);
    };
    const sleepSync = vi.fn<(ms: number) => void>();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new WorkflowScheduleStore({
      rootDir: tmpRoot,
      renameSync,
      sleepSync,
    });

    expect(() => store.list()).toThrow("Failed to archive unreadable workflow schedule store");
    expect(attempts).toBe(3);
    expect(sleepSync).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(schedulesFile(), "utf-8")).toBe(content);

    busy = false;
    expect(store.list()).toEqual([]);
    expect(attempts).toBe(4);
    expect(corruptScheduleArchives()).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(schedulesFile(), "utf-8"))).toEqual([]);
  });

  it("retries the complete scheduler restore after quarantine initially fails", async () => {
    vi.useFakeTimers();
    fs.writeFileSync(schedulesFile(), "{not-json", "utf-8");
    let attempts = 0;
    const renameSync: typeof fs.renameSync = (source, destination) => {
      attempts++;
      if (attempts <= 3) {
        throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
      }
      fs.renameSync(source, destination);
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new WorkflowScheduleStore({
      rootDir: tmpRoot,
      renameSync,
      sleepSync: () => {},
    });
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [entry({ manifest: { ...entry().manifest, schedule: "every hour" } })],
      hasActiveRunForKey: () => false,
      runScheduledWorkflow: vi.fn<() => Promise<{ runId: string; runFamilyId: string }>>(),
    });

    expect(() => scheduler.restore()).toThrow(
      "Failed to archive unreadable workflow schedule store",
    );
    expect(attempts).toBe(3);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(attempts).toBe(4);
    expect(store.get("user-local:test-workflow")?.naturalLanguage).toBe("every hour");
    expect(corruptScheduleArchives()).toHaveLength(1);
    scheduler.stop();
  });

  it("fails closed on read errors and retries without replacing the source", async () => {
    vi.useFakeTimers();
    const supportedRow = {
      schemaVersion: 1,
      key: "user-local:test-workflow",
      workflowId: "test-workflow",
      naturalLanguage: "every hour",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const unsupportedRow = {
      schemaVersion: 2,
      key: "user-local:future-workflow",
      enabled: false,
      futureField: { owner: "newer-version" },
    };
    const original = JSON.stringify([supportedRow, unsupportedRow], null, 2);
    fs.writeFileSync(schedulesFile(), original, "utf-8");
    let failRead = true;
    const readTextFileSync = (filePath: string): string => {
      if (failRead) {
        throw Object.assign(new Error("access denied"), { code: "EACCES" });
      }
      return fs.readFileSync(filePath, "utf-8");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot, readTextFileSync });
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [entry()],
      hasActiveRunForKey: () => false,
      runScheduledWorkflow: vi.fn<() => Promise<{ runId: string; runFamilyId: string }>>(),
    });

    expect(() => scheduler.restore()).toThrow("Failed to read workflow schedule store");
    expect(fs.readFileSync(schedulesFile(), "utf-8")).toBe(original);
    expect(() =>
      store.upsert({
        key: "user-local:second-workflow",
        workflowId: "second-workflow",
        naturalLanguage: "every day at 9am",
      }),
    ).toThrow("Failed to read workflow schedule store");
    expect(fs.readFileSync(schedulesFile(), "utf-8")).toBe(original);

    failRead = false;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(store.get("user-local:test-workflow")).toMatchObject({ enabled: true });
    expect(fs.readFileSync(schedulesFile(), "utf-8")).toBe(original);
    scheduler.stop();
  });

  it("retries the complete restore when manifest persistence initially fails", async () => {
    vi.useFakeTimers();
    let failWrite = true;
    let writeAttempts = 0;
    const atomicWriteFileSync: typeof secureAtomicWriteFileSync = (filePath, data, options) => {
      writeAttempts++;
      if (failWrite) {
        throw Object.assign(new Error("access denied"), { code: "EACCES" });
      }
      secureAtomicWriteFileSync(filePath, data, options);
    };
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot, atomicWriteFileSync });
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [entry({ manifest: { ...entry().manifest, schedule: "every hour" } })],
      hasActiveRunForKey: () => false,
      runScheduledWorkflow: vi.fn<() => Promise<{ runId: string; runFamilyId: string }>>(),
    });

    expect(() => scheduler.restore()).toThrow("access denied");
    expect(writeAttempts).toBe(1);
    expect(fs.existsSync(schedulesFile())).toBe(false);

    failWrite = false;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(writeAttempts).toBe(2);
    expect(store.get("user-local:test-workflow")?.naturalLanguage).toBe("every hour");
    scheduler.stop();
  });

  it("continues to ignore only invalid manifest schedule text", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [
        entry({ manifest: { ...entry().manifest, schedule: "definitely not a schedule" } }),
      ],
      hasActiveRunForKey: () => false,
      runScheduledWorkflow: vi.fn<() => Promise<{ runId: string; runFamilyId: string }>>(),
    });

    expect(() => scheduler.restore()).not.toThrow();
    expect(store.list()).toEqual([]);
    scheduler.stop();
  });

  it("preserves unsupported schedule rows and does not re-enable them on downgrade", () => {
    const unsupportedRow = {
      schemaVersion: 2,
      key: "user-local:test-workflow",
      workflowId: "test-workflow",
      naturalLanguage: "every hour",
      enabled: false,
      futureField: { owner: "newer-version" },
    };
    fs.writeFileSync(schedulesFile(), JSON.stringify([unsupportedRow], null, 2), "utf-8");
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [entry({ manifest: { ...entry().manifest, schedule: "every hour" } })],
      hasActiveRunForKey: () => false,
      runScheduledWorkflow: vi.fn<() => Promise<{ runId: string; runFamilyId: string }>>(),
    });

    scheduler.restore();

    expect(store.list({ includeDisabled: true })).toEqual([]);
    expect(JSON.parse(fs.readFileSync(schedulesFile(), "utf-8"))).toEqual([unsupportedRow]);
    expect(() =>
      store.upsert({
        key: "user-local:test-workflow",
        workflowId: "test-workflow",
        naturalLanguage: "every day at 9am",
      }),
    ).toThrow("unsupported schema version");

    store.upsert({
      key: "user-local:second-workflow",
      workflowId: "second-workflow",
      naturalLanguage: "every day at 9am",
    });
    const persisted: unknown = JSON.parse(fs.readFileSync(schedulesFile(), "utf-8"));
    expect(persisted).toEqual(
      expect.arrayContaining([
        unsupportedRow,
        expect.objectContaining({
          schemaVersion: 1,
          key: "user-local:second-workflow",
        }),
      ]),
    );
    scheduler.stop();
  });

  it("exposes parser and normalized schedule metadata", () => {
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    store.upsert({
      key: "user-local:test-workflow",
      workflowId: "test-workflow",
      naturalLanguage: "every day at 9am",
    });
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [entry()],
      hasActiveRunForKey: () => false,
      runScheduledWorkflow: vi.fn<() => Promise<{ runId: string; runFamilyId: string }>>(),
    });

    expect(scheduler.list()[0]).toMatchObject({
      parser: "electron/automations/parseSchedule",
      normalized: "every day at 9am",
      kind: "single",
    });
  });

  it("syncs manifest schedules on restore", () => {
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [entry({ manifest: { ...entry().manifest, schedule: "every hour" } })],
      hasActiveRunForKey: () => false,
      runScheduledWorkflow: vi.fn<() => Promise<{ runId: string; runFamilyId: string }>>(),
    });

    scheduler.restore();

    expect(store.get("user-local:test-workflow")?.naturalLanguage).toBe("every hour");
    scheduler.stop();
  });

  it("does not expose disabled schedules as live list summaries", () => {
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    store.upsert({
      key: "user-local:test-workflow",
      workflowId: "test-workflow",
      naturalLanguage: "every hour",
    });
    store.disable("user-local:test-workflow");
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [entry({ manifest: { ...entry().manifest, schedule: "every hour" } })],
      hasActiveRunForKey: () => false,
      runScheduledWorkflow: vi.fn<() => Promise<{ runId: string; runFamilyId: string }>>(),
    });

    scheduler.restore();

    expect(scheduler.list()).toEqual([]);
    expect(scheduler.get("user-local:test-workflow")).toBeNull();
    scheduler.stop();
  });

  it("keeps disabled manifest schedules as tombstones so restore does not re-enable them", () => {
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    store.upsert({
      key: "user-local:test-workflow",
      workflowId: "test-workflow",
      naturalLanguage: "every hour",
    });
    store.disable("user-local:test-workflow");
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [entry({ manifest: { ...entry().manifest, schedule: "every hour" } })],
      hasActiveRunForKey: () => false,
      runScheduledWorkflow: vi.fn<() => Promise<{ runId: string; runFamilyId: string }>>(),
    });

    scheduler.restore();

    expect(store.list({ includeDisabled: true })).toEqual([
      expect.objectContaining({
        key: "user-local:test-workflow",
        enabled: false,
      }),
    ]);
    scheduler.stop();
  });

  it("prunes disabled schedule tombstones after the manifest schedule goes away", () => {
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    store.upsert({
      key: "user-local:test-workflow",
      workflowId: "test-workflow",
      naturalLanguage: "every hour",
    });
    store.disable("user-local:test-workflow");
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [entry()],
      hasActiveRunForKey: () => false,
      runScheduledWorkflow: vi.fn<() => Promise<{ runId: string; runFamilyId: string }>>(),
    });

    scheduler.restore();

    expect(store.list({ includeDisabled: true })).toEqual([]);
    scheduler.stop();
  });

  it("starts due workflows and records trigger metadata", async () => {
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    store.upsert({
      key: "user-local:test-workflow",
      workflowId: "test-workflow",
      naturalLanguage: "every day at 9am",
    });
    store.patch("user-local:test-workflow", {
      lastCheckedAt: new Date(2026, 5, 9, 8, 59).getTime(),
    });
    const runScheduledWorkflow = vi
      .fn<() => Promise<{ runId: string; runFamilyId: string }>>()
      .mockResolvedValue({
        runId: "run-1",
        runFamilyId: "run-1",
      });
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [entry()],
      hasActiveRunForKey: () => false,
      runScheduledWorkflow,
    });

    const started = await scheduler.checkSchedules(new Date(2026, 5, 9, 9, 1));

    expect(started).toEqual([{ runId: "run-1", runFamilyId: "run-1" }]);
    expect(runScheduledWorkflow).toHaveBeenCalledTimes(1);
    expect(runScheduledWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ key: "user-local:test-workflow" }),
      {
        occurrenceAt: new Date(2026, 5, 9, 9, 0).getTime(),
        checkedAt: new Date(2026, 5, 9, 9, 1).getTime(),
      },
    );
    expect(store.get("user-local:test-workflow")?.lastRunId).toBe("run-1");
    expect(store.get("user-local:test-workflow")?.lastOccurrenceAt).toBe(
      new Date(2026, 5, 9, 9, 0).getTime(),
    );
  });

  it("uses the latest due interval occurrence for scheduled workflow metadata", async () => {
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    store.upsert({
      key: "user-local:test-workflow",
      workflowId: "test-workflow",
      naturalLanguage: "every hour",
    });
    store.patch("user-local:test-workflow", {
      lastCheckedAt: new Date(2026, 5, 9, 8, 10).getTime(),
    });
    const runScheduledWorkflow = vi
      .fn<() => Promise<{ runId: string; runFamilyId: string }>>()
      .mockResolvedValue({
        runId: "run-interval",
        runFamilyId: "run-interval",
      });
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [entry()],
      hasActiveRunForKey: () => false,
      runScheduledWorkflow,
    });

    await scheduler.checkSchedules(new Date(2026, 5, 9, 10, 20));

    expect(runScheduledWorkflow).toHaveBeenCalledWith(expect.anything(), {
      occurrenceAt: new Date(2026, 5, 9, 10, 0).getTime(),
      checkedAt: new Date(2026, 5, 9, 10, 20).getTime(),
    });
  });

  it("persists incremental cursor and includes it in scheduled run windows", async () => {
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    store.upsert({
      key: "user-local:hello-world",
      workflowId: "hello-world",
      naturalLanguage: "every hour",
    });
    const cursor = {
      shiftId: "shift-a",
      shiftStartAt: new Date(2026, 5, 9, 7, 0).getTime(),
      coveredThrough: new Date(2026, 5, 9, 9, 30).getTime(),
      active: true,
    };
    store.advanceIncrementalCursor("user-local:hello-world", cursor);
    store.patch("user-local:hello-world", {
      lastCheckedAt: new Date(2026, 5, 9, 9, 59).getTime(),
    });
    const runScheduledWorkflow = vi
      .fn<() => Promise<{ runId: string; runFamilyId: string }>>()
      .mockResolvedValue({ runId: "run-cursor", runFamilyId: "run-cursor" });
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [
        entry({
          id: "hello-world",
          key: "user-local:hello-world",
        }),
      ],
      hasActiveRunForKey: () => false,
      runScheduledWorkflow,
    });

    await scheduler.checkSchedules(new Date(2026, 5, 9, 10, 1));

    expect(runScheduledWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ incremental: expect.objectContaining(cursor) }),
      {
        occurrenceAt: new Date(2026, 5, 9, 10, 0).getTime(),
        checkedAt: new Date(2026, 5, 9, 10, 1).getTime(),
      },
    );
    expect(scheduler.list()[0].incremental).toMatchObject(cursor);
    expect(typeof scheduler.list()[0].nextRunAt).toBe("number");
  });

  it("preserves incremental cursor when an existing schedule is edited", () => {
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    store.upsert({
      key: "user-local:hello-world",
      workflowId: "hello-world",
      naturalLanguage: "every hour",
      input: { severity: 2 },
    });
    const cursor = {
      coveredThrough: new Date(2026, 5, 9, 9, 30).getTime(),
      data: { continuationToken: "opaque-token" },
    };
    store.advanceIncrementalCursor("user-local:hello-world", cursor);

    const updated = store.upsert({
      key: "user-local:hello-world",
      workflowId: "hello-world",
      naturalLanguage: "every day at 10am",
      input: { severity: 3 },
    });

    expect(updated.incremental).toMatchObject(cursor);
    expect(store.get("user-local:hello-world")?.incremental).toMatchObject(cursor);
  });

  it("can explicitly reset incremental cursor when upserting a schedule", () => {
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    store.upsert({
      key: "user-local:hello-world",
      workflowId: "hello-world",
      naturalLanguage: "every hour",
    });
    store.advanceIncrementalCursor("user-local:hello-world", {
      coveredThrough: new Date(2026, 5, 9, 9, 30).getTime(),
    });

    const updated = store.upsert({
      key: "user-local:hello-world",
      workflowId: "hello-world",
      naturalLanguage: "every day at 10am",
      resetIncremental: true,
    });

    expect(updated.incremental).toBeUndefined();
    expect(store.get("user-local:hello-world")?.incremental).toBeUndefined();
  });

  it("does not start a due workflow that already has an active run", async () => {
    const store = new WorkflowScheduleStore({ rootDir: tmpRoot });
    store.upsert({
      key: "user-local:test-workflow",
      workflowId: "test-workflow",
      naturalLanguage: "every day at 9am",
    });
    store.patch("user-local:test-workflow", {
      lastCheckedAt: new Date(2026, 5, 9, 8, 59).getTime(),
    });
    const runScheduledWorkflow = vi.fn<() => Promise<{ runId: string; runFamilyId: string }>>();
    const scheduler = new WorkflowScheduler({
      store,
      listEntries: () => [entry()],
      hasActiveRunForKey: () => true,
      runScheduledWorkflow,
    });

    await scheduler.checkSchedules(new Date(2026, 5, 9, 9, 1));

    expect(runScheduledWorkflow).not.toHaveBeenCalled();
  });
});
