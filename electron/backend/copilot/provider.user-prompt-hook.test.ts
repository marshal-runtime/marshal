/**
 * Verifies the wire-up between the CopilotSessionBackend's onUserPromptSubmitted
 * hook and the backend's configurable timezone provider. The per-turn date
 * anchor is the sole source of truth for "today" (see system-message.ts), so
 * if this hook silently regresses to system-local time, long-running sessions
 * in non-system timezones would see stale or mis-zoned dates with no other
 * test catching it.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

import { createTestBackend } from "../../testing/harness";
import type { CopilotBackend } from "./provider";

vi.mock("fs", () => ({
  default: { existsSync: vi.fn<() => boolean>(() => false), constants: { X_OK: 1 } },
  existsSync: vi.fn<() => boolean>(() => false),
  constants: { X_OK: 1 },
}));

vi.mock("child_process", () => ({
  spawn: vi.fn<() => void>(),
  execFile: vi.fn<() => void>(),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getVersion: () => "0.0.0-test",
    getPath: () => "/tmp",
  },
}));

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn<() => void>(),
  CopilotSession: vi.fn<() => void>(),
}));

interface SessionBackendInternals {
  buildHooks: (
    sessionId: string,
    isAutomated: boolean,
  ) => {
    onUserPromptSubmitted?: (input: { prompt: string }) => { modifiedPrompt: string };
  };
}

async function buildHooksFor(tz: string | (() => string)): Promise<{
  onUserPromptSubmitted: (input: { prompt: string }) => { modifiedPrompt: string };
}> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test constructs real CopilotBackend via the shared helper
  const backend = (await createTestBackend()) as CopilotBackend;
  backend.setTimezoneProvider(typeof tz === "function" ? tz : () => tz);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- buildHooks is private; tests reach it via a narrow typed escape hatch
  const internals = backend.sessions as unknown as SessionBackendInternals;
  const hooks = internals.buildHooks("test-session", false);
  if (!hooks.onUserPromptSubmitted) throw new Error("onUserPromptSubmitted was not registered");
  return { onUserPromptSubmitted: hooks.onUserPromptSubmitted };
}

describe("onUserPromptSubmitted hook wire-up", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers onUserPromptSubmitted as part of session hooks", async () => {
    const { onUserPromptSubmitted } = await buildHooksFor("UTC");
    expect(typeof onUserPromptSubmitted).toBe("function");
  });

  it("reads the timezone from the backend's provider (not system local)", async () => {
    // 2026-04-21T05:08:12Z == Tuesday 1:08 AM EDT, Monday 10:08 PM PDT.
    // Whichever timezone the system is in, the hook must produce NY-formatted output.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T05:08:12Z"));

    const { onUserPromptSubmitted } = await buildHooksFor("America/New_York");
    const { modifiedPrompt } = onUserPromptSubmitted({ prompt: "What day is it?" });

    expect(modifiedPrompt).toContain("What day is it?");
    expect(modifiedPrompt).toContain("Tuesday");
    expect(modifiedPrompt).toContain("April 21, 2026");
    expect(modifiedPrompt).toContain("EDT");
  });

  it("re-reads the provider on each invocation so mid-session tz changes take effect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T05:08:12Z"));

    let tz = "America/Los_Angeles";
    const { onUserPromptSubmitted } = await buildHooksFor(() => tz);

    const first = onUserPromptSubmitted({ prompt: "hi" });
    expect(first.modifiedPrompt).toContain("PDT");
    expect(first.modifiedPrompt).toContain("Monday");

    tz = "America/New_York";
    const second = onUserPromptSubmitted({ prompt: "hi" });
    expect(second.modifiedPrompt).toContain("EDT");
    expect(second.modifiedPrompt).toContain("Tuesday");
    expect(second.modifiedPrompt).not.toContain("PDT");
  });
});
