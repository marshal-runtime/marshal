import { describe, expect, it } from "vitest";

import {
  SWITCH_CONTEXT_MAX_CHARS,
  SWITCH_CONTEXT_MAX_MESSAGE_CHARS,
  SWITCH_CONTEXT_MAX_MESSAGES,
  buildBoundedSwitchContext,
  describeModelSwitchFailure,
  planSessionModelSwitch,
} from "./session-model-switch";

const claudeSession = { runtimeId: "claude", model: "claude-opus-5-5[1m]" };

describe("planSessionModelSwitch", () => {
  it("switches in place when the runtime stays the same and a live switch is preferred", () => {
    expect(
      planSessionModelSwitch({
        session: claudeSession,
        nextModel: "claude-sonnet-4-5",
        backend: "live",
        liveSwitch: true,
      }),
    ).toEqual({
      mode: "live",
      fromRuntimeId: "claude",
      toRuntimeId: "claude",
      crossRuntime: false,
    });
  });

  it("keeps today's recreate path for same-runtime switches without a live preference", () => {
    expect(
      planSessionModelSwitch({
        session: claudeSession,
        nextModel: "claude-sonnet-4-5",
        backend: "live",
        liveSwitch: false,
      }).mode,
    ).toBe("recreate");
  });

  it("recreates the backend when the model runs on another runtime", () => {
    expect(
      planSessionModelSwitch({
        session: claudeSession,
        nextModel: "cursor:gpt-5.6-luna",
        backend: "live",
        liveSwitch: true,
      }),
    ).toEqual({
      mode: "recreate",
      fromRuntimeId: "claude",
      toRuntimeId: "cursor",
      crossRuntime: true,
    });
  });

  it("treats a peer session moving back to the active runtime as cross-runtime", () => {
    expect(
      planSessionModelSwitch({
        session: { runtimeId: "claude", model: "cursor:gpt-5.6-luna" },
        nextModel: "claude-opus-5-5[1m]",
        backend: "live",
        liveSwitch: true,
      }),
    ).toMatchObject({ mode: "recreate", fromRuntimeId: "cursor", toRuntimeId: "claude" });
  });

  it("treats moving a session to another account of the same runtime as cross-runtime", () => {
    expect(
      planSessionModelSwitch({
        session: claudeSession,
        nextModel: "claude@work:claude-opus-5-5[1m]",
        backend: "live",
        liveSwitch: true,
      }),
    ).toEqual({
      mode: "recreate",
      fromRuntimeId: "claude",
      toRuntimeId: "claude@work",
      crossRuntime: true,
    });
  });

  it("switches in place within an account however the original account is spelled", () => {
    expect(
      planSessionModelSwitch({
        session: { runtimeId: "claude", model: "claude@work:claude-opus-5-5[1m]" },
        nextModel: "claude@work:claude-sonnet-4-5",
        backend: "live",
        liveSwitch: true,
      }),
    ).toMatchObject({ mode: "live", crossRuntime: false });
    expect(
      planSessionModelSwitch({
        session: claudeSession,
        nextModel: "claude@default:claude-sonnet-4-5",
        backend: "live",
        liveSwitch: true,
      }),
    ).toMatchObject({ mode: "live", crossRuntime: false });
  });

  it("recreates a backend that is still starting and only persists when none runs", () => {
    const base = { session: claudeSession, nextModel: "claude-sonnet-4-5", liveSwitch: true };
    expect(planSessionModelSwitch({ ...base, backend: "starting" }).mode).toBe("recreate");
    expect(
      planSessionModelSwitch({ ...base, nextModel: "cursor:gpt-5.6-luna", backend: "none" }),
    ).toMatchObject({ mode: "persist-only", crossRuntime: true });
  });
});

function messages(count: number, content = "hello") {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${content} ${index}`,
  }));
}

describe("buildBoundedSwitchContext", () => {
  it("returns null for an empty conversation", () => {
    expect(buildBoundedSwitchContext([])).toBeNull();
  });

  it("keeps a short conversation verbatim", () => {
    expect(buildBoundedSwitchContext(messages(3))).toBe(
      "User: hello 0\n\nAssistant: hello 1\n\nUser: hello 2",
    );
  });

  it("keeps only the most recent messages and says how many were omitted", () => {
    const context = buildBoundedSwitchContext(messages(SWITCH_CONTEXT_MAX_MESSAGES + 6)) ?? "";
    expect(context.startsWith("(6 earlier messages omitted)")).toBe(true);
    expect(context).not.toContain("hello 5\n");
    expect(context).toContain(`hello ${SWITCH_CONTEXT_MAX_MESSAGES + 5}`);
  });

  it("truncates long messages and bounds the total size", () => {
    const long = "x".repeat(SWITCH_CONTEXT_MAX_MESSAGE_CHARS * 3);
    const context = buildBoundedSwitchContext(messages(20, long)) ?? "";
    expect(context).toContain("… [truncated]");
    expect(context.length).toBeLessThanOrEqual(SWITCH_CONTEXT_MAX_CHARS + 200);
  });

  it("prefixes the cached summary and adds only the messages after it", () => {
    const conversation = messages(8);
    expect(
      buildBoundedSwitchContext(conversation, { summary: "Earlier: set up.", upToMessageId: "m5" }),
    ).toBe(
      "Earlier: set up.\n\n### Messages since that summary\n\nUser: hello 6\n\nAssistant: hello 7",
    );
    expect(
      buildBoundedSwitchContext(conversation, { summary: "All of it.", upToMessageId: "m7" }),
    ).toBe("All of it.");
  });

  it("ignores a cached summary whose anchor message is gone", () => {
    expect(
      buildBoundedSwitchContext(messages(2), { summary: "Stale.", upToMessageId: "gone" }),
    ).toBe("User: hello 0\n\nAssistant: hello 1");
  });
});

describe("describeModelSwitchFailure", () => {
  it("tells the user to sign in when the destination is not authenticated", () => {
    const text = describeModelSwitchFailure({
      fromRuntimeId: "claude",
      toRuntimeId: "codex",
      error: new Error("Not signed in: authentication required"),
    });
    expect(text).toContain("Couldn't switch this chat to Codex");
    expect(text).toContain("The chat stays on Claude Agent.");
    expect(text).toContain(
      "Codex isn't signed in. Sign in under Settings → Runtime accounts, then pick the model again.",
    );
  });

  it("names the account and suggests another model when the catalog lacks it", () => {
    const text = describeModelSwitchFailure({
      fromRuntimeId: "claude",
      toRuntimeId: "claude@work",
      error: new Error('Model "opus" is not available in the claude@work runtime.'),
    });
    expect(text).toContain("to Claude Agent (work)");
    expect(text).toContain("Pick a model from Claude Agent (work)'s list");
  });

  it("explains usage limits and falls back to a generic next step", () => {
    expect(
      describeModelSwitchFailure({
        fromRuntimeId: "codex",
        toRuntimeId: "cursor",
        error: new Error("Usage limit reached for this plan"),
      }),
    ).toContain("hit a usage limit");
    expect(
      describeModelSwitchFailure({
        fromRuntimeId: "codex",
        toRuntimeId: "cursor",
        error: new Error("spawn failed"),
      }),
    ).toContain("spawn failed. The chat stays on Codex. Check Cursor under Settings");
  });
});
