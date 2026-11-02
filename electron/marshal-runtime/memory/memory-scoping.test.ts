import { describe, expect, it } from "vitest";

import {
  createdAtWithin,
  memoryAppliesTo,
  memoryAppliesToProject,
  normalizeRecallWindow,
} from "./memory-scoping";

describe("memory scoping", () => {
  it("treats missing, blank and global appliesTo as global", () => {
    expect(memoryAppliesTo({})).toBe("global");
    expect(memoryAppliesTo({ appliesTo: "  " })).toBe("global");
    expect(memoryAppliesTo({ appliesTo: "project-a" })).toBe("project-a");
  });

  it("admits global memories everywhere and project memories only in their project", () => {
    expect(memoryAppliesToProject({}, undefined)).toBe(true);
    expect(memoryAppliesToProject({ appliesTo: "project-a" }, "project-a")).toBe(true);
    expect(memoryAppliesToProject({ appliesTo: "project-a" }, "project-b")).toBe(false);
    expect(memoryAppliesToProject({ appliesTo: "project-a" }, undefined)).toBe(false);
  });

  it("normalizes date-only bounds to whole UTC days and keeps datetimes exact", () => {
    expect(normalizeRecallWindow({ since: "2026-09-01", until: "2026-09-02" })).toEqual({
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-02T23:59:59.999Z",
    });
    expect(normalizeRecallWindow({ since: "2026-09-01T10:00:00+02:00" })).toEqual({
      since: "2026-09-01T08:00:00.000Z",
    });
    expect(normalizeRecallWindow({})).toEqual({});
  });

  it("rejects unparseable and inverted windows", () => {
    expect(() => normalizeRecallWindow({ since: "yesterday" })).toThrow(RangeError);
    expect(() => normalizeRecallWindow({ until: "2026-13-45" })).toThrow(RangeError);
    expect(() => normalizeRecallWindow({ since: "2026-09-03", until: "2026-09-02" })).toThrow(
      "since must not be later than until.",
    );
  });

  it("filters createdAt inclusively and excludes undated entries only when bounded", () => {
    const within = createdAtWithin({
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-02T23:59:59.999Z",
    });

    expect(within({ createdAt: "2026-09-01T00:00:00.000Z" })).toBe(true);
    expect(within({ createdAt: "2026-09-02T23:59:59.999Z" })).toBe(true);
    expect(within({ createdAt: "2026-09-03T00:00:00.000Z" })).toBe(false);
    expect(within({ createdAt: "not a date" })).toBe(false);
    expect(createdAtWithin(undefined)({ createdAt: "not a date" })).toBe(true);
  });
});
