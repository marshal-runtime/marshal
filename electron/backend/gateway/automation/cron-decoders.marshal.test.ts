// Marshal-owned test
import { describe, expect, it } from "vitest";

import {
  cronJobCreateToParams,
  parseCronJobId,
  parseCronJobList,
  parseCronPayload,
  parseCronRunLogEntries,
  parseCronSchedule,
  parseCronSessionTarget,
  parseCronWakeMode,
  recordToCronJob,
  recordToCronRunLogEntry,
} from "./cron-decoders";
import type { CronJobCreate } from "./map";

const validJobShape = {
  id: "j1",
  name: "Test job",
  enabled: true,
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_001_000,
  schedule: { kind: "at", at: "2026-12-31T00:00:00Z" },
  sessionTarget: "main",
  wakeMode: "now",
  payload: { kind: "systemEvent", text: "hello" },
  state: { lastRunMs: null },
};

describe("cronJobCreateToParams", () => {
  it("spreads CronJobCreate into a plain object", () => {
    const body: CronJobCreate = {
      name: "x",
      enabled: true,
      schedule: { kind: "at", at: "2026-01-01T00:00:00Z" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "ping" },
    };
    const params = cronJobCreateToParams(body);
    expect(params).toEqual(body);
    params.name = "y";
    expect(body.name).toBe("x");
  });
});

describe("parseCronJobList", () => {
  it("throws on non-record input", () => {
    expect(() => parseCronJobList(null)).toThrow(/expected \{ jobs: \[\.\.\.\] \}/);
    expect(() => parseCronJobList(42)).toThrow(/expected \{ jobs: \[\.\.\.\] \}/);
    expect(() => parseCronJobList("nope")).toThrow(/expected \{ jobs: \[\.\.\.\] \}/);
  });

  it("throws when `jobs` is missing or not an array", () => {
    expect(() => parseCronJobList({})).toThrow(/expected \{ jobs: \[\.\.\.\] \}/);
    expect(() => parseCronJobList({ jobs: "not-array" })).toThrow(
      /expected \{ jobs: \[\.\.\.\] \}/,
    );
  });

  it("returns an empty array for { jobs: [] }", () => {
    expect(parseCronJobList({ jobs: [] })).toEqual([]);
  });

  it("maps a valid jobs array", () => {
    const jobs = parseCronJobList({ jobs: [validJobShape] });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("j1");
  });

  it("propagates the inner record error when an item is malformed", () => {
    expect(() => parseCronJobList({ jobs: [validJobShape, { id: "missing-fields" }] })).toThrow(
      /gateway-automation-backend/,
    );
  });
});

describe("parseCronRunLogEntries", () => {
  it("throws on non-record / missing entries", () => {
    expect(() => parseCronRunLogEntries(null)).toThrow(/expected \{ entries: \[\.\.\.\] \}/);
    expect(() => parseCronRunLogEntries({})).toThrow(/expected \{ entries: \[\.\.\.\] \}/);
    expect(() => parseCronRunLogEntries({ entries: "x" })).toThrow(
      /expected \{ entries: \[\.\.\.\] \}/,
    );
  });

  it("returns an empty array for { entries: [] }", () => {
    expect(parseCronRunLogEntries({ entries: [] })).toEqual([]);
  });

  it("delegates to recordToCronRunLogEntry for each entry", () => {
    const entries = parseCronRunLogEntries({
      entries: [
        { ts: 1_700_000_000_000, status: "ok" },
        { ts: 1_700_000_001_000, status: "error", error: "boom" },
      ],
    });
    expect(entries).toHaveLength(2);
    expect(entries[0].status).toBe("ok");
    expect(entries[1].error).toBe("boom");
  });
});

describe("parseCronJobId", () => {
  it("returns id when valid", () => {
    expect(parseCronJobId({ id: "abc" })).toBe("abc");
  });

  it("throws on missing or non-string id", () => {
    expect(() => parseCronJobId({})).toThrow(/expected \{ id: string \}/);
    expect(() => parseCronJobId({ id: 42 })).toThrow(/expected \{ id: string \}/);
    expect(() => parseCronJobId(null)).toThrow(/expected \{ id: string \}/);
  });
});

describe("recordToCronJob", () => {
  it("throws on non-record input", () => {
    expect(() => recordToCronJob(null)).toThrow(/expected CronJob object/);
    expect(() => recordToCronJob("string")).toThrow(/expected CronJob object/);
  });

  it("throws when required fields are missing or have wrong types", () => {
    const wrongTypeId = { ...validJobShape, id: 42 };
    expect(() => recordToCronJob(wrongTypeId)).toThrow(/CronJob missing required fields/);
    const noState = { ...validJobShape };
    delete (noState as Record<string, unknown>).state;
    expect(() => recordToCronJob(noState)).toThrow(/CronJob missing required fields/);
  });

  it("decodes optional description / deleteAfterRun fields", () => {
    const job = recordToCronJob({
      ...validJobShape,
      description: "test",
      deleteAfterRun: true,
    });
    expect(job.description).toBe("test");
    expect(job.deleteAfterRun).toBe(true);
  });

  it("includes delivery only when mode is recognized", () => {
    const okModes: Array<"none" | "announce" | "webhook"> = ["none", "announce", "webhook"];
    for (const mode of okModes) {
      const job = recordToCronJob({ ...validJobShape, delivery: { mode } });
      expect(job.delivery?.mode).toBe(mode);
    }
    const dropped = recordToCronJob({ ...validJobShape, delivery: { mode: "future-mode" } });
    expect(dropped.delivery).toBeUndefined();
    const droppedNonRecord = recordToCronJob({ ...validJobShape, delivery: "string" });
    expect(droppedNonRecord.delivery).toBeUndefined();
  });
});

describe("parseCronSchedule", () => {
  it("decodes kind=at", () => {
    expect(parseCronSchedule({ kind: "at", at: "2026-01-01T00:00:00Z" })).toEqual({
      kind: "at",
      at: "2026-01-01T00:00:00Z",
    });
  });

  it("decodes kind=every with optional anchorMs", () => {
    expect(parseCronSchedule({ kind: "every", everyMs: 60_000 })).toEqual({
      kind: "every",
      everyMs: 60_000,
    });
    expect(
      parseCronSchedule({ kind: "every", everyMs: 60_000, anchorMs: 1_700_000_000_000 }),
    ).toEqual({
      kind: "every",
      everyMs: 60_000,
      anchorMs: 1_700_000_000_000,
    });
  });

  it("decodes kind=cron with optional tz / staggerMs", () => {
    expect(parseCronSchedule({ kind: "cron", expr: "0 9 * * 1-5" })).toEqual({
      kind: "cron",
      expr: "0 9 * * 1-5",
    });
    expect(
      parseCronSchedule({
        kind: "cron",
        expr: "0 9 * * 1-5",
        tz: "America/Los_Angeles",
        staggerMs: 60_000,
      }),
    ).toEqual({
      kind: "cron",
      expr: "0 9 * * 1-5",
      tz: "America/Los_Angeles",
      staggerMs: 60_000,
    });
  });

  it("throws on non-record", () => {
    expect(() => parseCronSchedule(null)).toThrow(/schedule must be an object/);
  });

  it("throws on unknown kind or wrong-typed kind-specific fields", () => {
    // Both surface as the "unknown schedule kind" error because the decoder
    // uses a single combined pattern-match per kind.
    expect(() => parseCronSchedule({ kind: "weekly" })).toThrow(/unknown schedule kind/);
    expect(() => parseCronSchedule({ kind: "at", at: 42 })).toThrow(/unknown schedule kind/);
  });
});

describe("parseCronSessionTarget", () => {
  it.each(["main", "isolated", "current"])("decodes literal %s", (target) => {
    expect(parseCronSessionTarget(target)).toBe(target);
  });

  it("decodes session:<id> dynamic targets", () => {
    expect(parseCronSessionTarget("session:abc-123")).toBe("session:abc-123");
    expect(parseCronSessionTarget("session:")).toBe("session:");
  });

  it("throws on plain strings without the session: prefix", () => {
    expect(() => parseCronSessionTarget("other")).toThrow(/invalid sessionTarget/);
    expect(() => parseCronSessionTarget("")).toThrow(/invalid sessionTarget/);
  });

  it("throws on non-string", () => {
    expect(() => parseCronSessionTarget(42)).toThrow(/invalid sessionTarget/);
    expect(() => parseCronSessionTarget(null)).toThrow(/invalid sessionTarget/);
  });
});

describe("parseCronWakeMode", () => {
  it("returns canonical values unchanged", () => {
    expect(parseCronWakeMode("next-heartbeat")).toBe("next-heartbeat");
    expect(parseCronWakeMode("now")).toBe("now");
  });

  it("falls back to `now` for unknown string values (forward-compat)", () => {
    expect(parseCronWakeMode("future-mode")).toBe("now");
  });

  it("throws on non-string", () => {
    expect(() => parseCronWakeMode(42)).toThrow(/wakeMode must be a string/);
    expect(() => parseCronWakeMode(null)).toThrow(/wakeMode must be a string/);
  });
});

describe("parseCronPayload", () => {
  it("decodes systemEvent payloads", () => {
    expect(parseCronPayload({ kind: "systemEvent", text: "hello" })).toEqual({
      kind: "systemEvent",
      text: "hello",
    });
  });

  it("decodes agentTurn with required message", () => {
    expect(parseCronPayload({ kind: "agentTurn", message: "do thing" })).toEqual({
      kind: "agentTurn",
      message: "do thing",
    });
  });

  it("decodes agentTurn with optional fields", () => {
    const payload = parseCronPayload({
      kind: "agentTurn",
      message: "do thing",
      model: "claude-opus-4-7",
      fallbacks: ["claude-sonnet-4-6", 42, "claude-haiku-4-5-20251001"],
      thinking: "high",
      timeoutSeconds: 60,
      toolsAllow: ["read", null, "write"],
    });
    expect(payload).toEqual({
      kind: "agentTurn",
      message: "do thing",
      model: "claude-opus-4-7",
      fallbacks: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
      thinking: "high",
      timeoutSeconds: 60,
      toolsAllow: ["read", "write"],
    });
  });

  it("throws on non-record", () => {
    expect(() => parseCronPayload(null)).toThrow(/payload must be an object/);
  });

  it("throws on unknown kind or wrong-typed kind-specific fields", () => {
    // All three surface as "unknown payload kind" because the decoder uses a
    // single combined pattern-match per kind.
    expect(() => parseCronPayload({ kind: "tool", message: "x" })).toThrow(/unknown payload kind/);
    expect(() => parseCronPayload({ kind: "systemEvent" })).toThrow(/unknown payload kind/);
    expect(() => parseCronPayload({ kind: "agentTurn", message: 42 })).toThrow(
      /unknown payload kind/,
    );
  });
});

describe("recordToCronRunLogEntry", () => {
  it("throws on non-record", () => {
    expect(() => recordToCronRunLogEntry(null)).toThrow(/expected CronRunLogEntry object/);
  });

  it("throws on missing ts", () => {
    expect(() => recordToCronRunLogEntry({ status: "ok" })).toThrow(/missing required fields/);
  });

  it("throws on invalid status", () => {
    expect(() => recordToCronRunLogEntry({ ts: 1, status: "weird" })).toThrow(
      /missing required fields/,
    );
  });

  it("decodes minimal entry with required fields", () => {
    expect(recordToCronRunLogEntry({ ts: 1_700_000_000_000, status: "ok" })).toEqual({
      ts: 1_700_000_000_000,
      status: "ok",
    });
  });

  it("decodes entry with all optional fields", () => {
    const entry = recordToCronRunLogEntry({
      ts: 1_700_000_000_000,
      status: "error",
      runAtMs: 1_700_000_000_500,
      sessionId: "s1",
      sessionKey: "key1",
      summary: "summary text",
      error: "boom",
      durationMs: 250,
      model: "claude-opus-4-7",
    });
    expect(entry).toEqual({
      ts: 1_700_000_000_000,
      status: "error",
      runAtMs: 1_700_000_000_500,
      sessionId: "s1",
      sessionKey: "key1",
      summary: "summary text",
      error: "boom",
      durationMs: 250,
      model: "claude-opus-4-7",
    });
  });

  it("drops optional fields with wrong types", () => {
    const entry = recordToCronRunLogEntry({
      ts: 1,
      status: "skipped",
      runAtMs: "not-a-number",
      sessionId: 42,
    });
    expect(entry).toEqual({ ts: 1, status: "skipped" });
  });
});
