// Marshal-owned module.
import { describe, it, expect, vi, afterEach } from "vitest";

import {
  formatChatTooltip,
  formatDate,
  formatDateFull,
  formatMessageTime,
  getDateKey,
} from "./date";

describe("getDateKey", () => {
  it("returns YYYY-MM-DD format", () => {
    expect(getDateKey(new Date(2026, 2, 25))).toBe("2026-03-25");
  });

  it("zero-pads month and day", () => {
    expect(getDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("formatDate", () => {
  afterEach(() => vi.useRealTimers());

  it("returns 'Just now' for less than a minute ago", () => {
    const now = new Date();
    expect(formatDate(now.toISOString())).toBe("Just now");
  });

  it("returns minutes ago for < 60 minutes", () => {
    const date = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatDate(date.toISOString())).toBe("5m ago");
  });

  it("returns hours ago for < 24 hours", () => {
    const date = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(formatDate(date.toISOString())).toBe("3h ago");
  });

  it("returns days ago for < 7 days", () => {
    const date = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(formatDate(date.toISOString())).toBe("2d ago");
  });

  it("returns locale date string for >= 7 days", () => {
    const date = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const result = formatDate(date.toISOString());
    expect(result).not.toContain("ago");
  });
});

describe("formatDateFull", () => {
  afterEach(() => vi.useRealTimers());

  it("includes day-first date and 12-hour time", () => {
    vi.useFakeTimers({ now: new Date("2026-04-21T15:00:00") });
    const result = formatDateFull("2026-04-21T14:31:00");
    expect(result).toMatch(/21 Apr, 2:31 pm/);
  });

  it("appends (just now) for less than a minute ago", () => {
    const now = new Date();
    const result = formatDateFull(now.toISOString());
    expect(result).toContain("(just now)");
  });

  it("appends relative minutes for < 60 minutes ago", () => {
    const date = new Date(Date.now() - 5 * 60 * 1000);
    const result = formatDateFull(date.toISOString());
    expect(result).toContain("(5m ago)");
  });

  it("appends relative hours for < 24 hours ago", () => {
    const date = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const result = formatDateFull(date.toISOString());
    expect(result).toContain("(3h ago)");
  });

  it("does not append relative time for >= 24 hours ago", () => {
    const date = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const result = formatDateFull(date.toISOString());
    expect(result).not.toContain("ago");
  });

  it("includes year when date is from a different year", () => {
    vi.useFakeTimers({ now: new Date("2026-03-25T12:00:00") });
    const result = formatDateFull("2025-06-15T10:00:00");
    expect(result).toContain("2025");
  });

  it("returns empty string for invalid date input", () => {
    expect(formatDateFull("")).toBe("");
    expect(formatDateFull("not-a-date")).toBe("not-a-date");
  });
});

describe("formatChatTooltip", () => {
  it("formats as day-first with year and 12-hour time", () => {
    const result = formatChatTooltip(new Date("2026-03-25T14:00:00"));
    expect(result).toBe("25 Mar 2026, 2:00 pm");
  });

  it("formats evening time in 12-hour", () => {
    const result = formatChatTooltip(new Date("2026-04-17T20:35:00"));
    expect(result).toBe("17 Apr 2026, 8:35 pm");
  });

  it("always includes year", () => {
    const result = formatChatTooltip(new Date("2026-03-20T10:00:00"));
    expect(result).toContain("2026");
  });

  it("does not include timezone or relative time", () => {
    const result = formatChatTooltip(new Date());
    expect(result).not.toContain("ago");
  });

  it("returns empty string for invalid date input", () => {
    expect(formatChatTooltip(new Date("invalid"))).toBe("");
  });
});

describe("formatMessageTime", () => {
  afterEach(() => vi.useRealTimers());

  it("returns clock time with space before am/pm for today", () => {
    vi.useFakeTimers({ now: new Date("2026-04-18T15:00:00") });
    expect(formatMessageTime(new Date("2026-04-18T11:03:00"))).toBe("11:03 am");
    expect(formatMessageTime(new Date("2026-04-18T14:30:00"))).toBe("2:30 pm");
    expect(formatMessageTime(new Date("2026-04-18T00:05:00"))).toBe("12:05 am");
    expect(formatMessageTime(new Date("2026-04-18T12:00:00"))).toBe("12:00 pm");
  });

  it("shows date only for non-today messages this year", () => {
    vi.useFakeTimers({ now: new Date("2026-04-20T12:00:00") });
    const result = formatMessageTime(new Date("2026-04-18T11:03:00"));
    expect(result).toBe("18 Apr");
  });

  it("shows date with year for messages from a previous year", () => {
    vi.useFakeTimers({ now: new Date("2026-04-20T12:00:00") });
    const result = formatMessageTime(new Date("2025-12-25T10:00:00"));
    expect(result).toBe("25 Dec 2025");
  });

  it("returns empty string for invalid date", () => {
    expect(formatMessageTime(new Date("invalid"))).toBe("");
  });
});
