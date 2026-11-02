// Marshal-owned test
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("../app-paths", () => ({ getAppDataDir: () => "/tmp/test-home" }));
vi.mock("../mock-mode", () => ({
  isMockMode: () => false,
}));

import { AutomationImportSchema, AutomationSchema } from "./schemas";

describe("AutomationSchema automation options", () => {
  it("retains browserHeadless=true and model through parse", () => {
    const input = {
      id: "a1",
      name: "test",
      steps: [{ id: "s1", label: "x", prompt: "y" }],
      schedule: {
        kind: "single",
        naturalLanguage: "every day at 9am",
        days: [],
        hour: 9,
        minute: 0,
        time: { hour: 9, minute: 0 },
      },
      enabled: true,
      createdAt: "2026-05-02T00:00:00Z",
      updatedAt: "2026-05-02T00:00:00Z",
      triggerType: "schedule" as const,
      browserHeadless: true,
      model: "claude-haiku-4.5",
    };
    const result = AutomationSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.browserHeadless).toBe(true);
    expect(result.data.model).toBe("claude-haiku-4.5");
  });

  it("treats omitted browserHeadless as undefined", () => {
    const input = {
      id: "a1",
      name: "test",
      steps: [{ id: "s1", label: "x", prompt: "y" }],
      schedule: {
        kind: "single",
        naturalLanguage: "9am",
        days: [],
        hour: 9,
        minute: 0,
        time: { hour: 9, minute: 0 },
      },
      enabled: true,
      createdAt: "2026-05-02T00:00:00Z",
      updatedAt: "2026-05-02T00:00:00Z",
      triggerType: "schedule" as const,
    };
    const result = AutomationSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.browserHeadless).toBeUndefined();
  });

  it("AutomationImportSchema accepts browserHeadless and model", () => {
    const input = {
      name: "import",
      steps: [{ label: "x", prompt: "y" }],
      schedule: {
        kind: "single",
        naturalLanguage: "9am",
        days: [],
        hour: 9,
        minute: 0,
        time: { hour: 9, minute: 0 },
      },
      browserHeadless: true,
      model: "claude-haiku-4.5",
    };
    const result = AutomationImportSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.browserHeadless).toBe(true);
    expect(result.data.model).toBe("claude-haiku-4.5");
  });
});

describe("AutomationSchema teamsNotify", () => {
  const baseInput = {
    id: "a1",
    name: "test",
    steps: [{ id: "s1", label: "x", prompt: "y" }],
    schedule: {
      kind: "single" as const,
      naturalLanguage: "every day at 9am",
      days: [],
      hour: 9,
      minute: 0,
      time: { hour: 9, minute: 0 },
    },
    enabled: true,
    createdAt: "2026-05-13T00:00:00Z",
    updatedAt: "2026-05-13T00:00:00Z",
    triggerType: "schedule" as const,
  };

  it.each(["always", "auto", "never"] as const)("round-trips teamsNotify=%s", (value) => {
    const result = AutomationSchema.safeParse({ ...baseInput, teamsNotify: value });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.teamsNotify).toBe(value);
  });

  it("treats omitted teamsNotify as undefined (runtime resolves to 'always')", () => {
    const result = AutomationSchema.safeParse(baseInput);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.teamsNotify).toBeUndefined();
  });

  it("rejects unknown teamsNotify values", () => {
    const result = AutomationSchema.safeParse({ ...baseInput, teamsNotify: "sometimes" });
    expect(result.success).toBe(false);
  });

  it("AutomationImportSchema accepts teamsNotify", () => {
    const result = AutomationImportSchema.safeParse({
      name: "import",
      steps: [{ label: "x", prompt: "y" }],
      schedule: {
        kind: "single",
        naturalLanguage: "9am",
        days: [],
        hour: 9,
        minute: 0,
        time: { hour: 9, minute: 0 },
      },
      teamsNotify: "auto",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.teamsNotify).toBe("auto");
  });
});
