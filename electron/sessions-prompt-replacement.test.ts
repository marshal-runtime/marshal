/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
vi.mock("fs", m.fsFactory);
vi.mock("./session-archive", m.sessionArchiveFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", async (importOriginal) => {
  const original = await importOriginal<typeof import("./skills")>();
  return { ...m.skillsFactory(), getSkillsForSystemPrompt: original.getSkillsForSystemPrompt };
});
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file");

import * as fs from "fs";

import { createTestBackend } from "./testing/harness";

const mockedFs = vi.mocked(fs);

/**
 * Flag-path tests for the staged prompt-replacement experiment: the session
 * layer must produce the assembled Marshal prompt with mode "replace" for
 * supported runtimes when the flag is on, with the deduplicated session tail
 * and per-session extension contributions.
 */
describe("SessionManager prompt replacement (staged experiment)", () => {
  let mgr: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readdirSync.mockReturnValue([]);
    mockedFs.readFileSync.mockReturnValue("{}");
    const { SessionManager } = await import("./sessions");
    mgr = new SessionManager("/test/workspace", await createTestBackend());
    const rows = [
      { id: "claude-1", runtimeId: "claude", source: "user" },
      { id: "cursor-1", runtimeId: "cursor", source: "user" },
      { id: "codex-1", runtimeId: "codex", source: "user" },
      { id: "copilot-1", runtimeId: "copilot", source: "user" },
      {
        id: "claude-reviewer",
        runtimeId: "claude",
        source: "subagent",
        permissionMode: "read-only-reviewer",
        runtimeAgentRole: "reviewer",
      },
    ];
    mgr.store.loadIndex = () => ({ sessions: rows });
    mgr.store.loadSessionData = (id: string) => rows.find((row) => row.id === id) ?? null;
    process.env.MARSHAL_PROMPT_V2 = "1";
  });

  afterEach(() => {
    delete process.env.MARSHAL_PROMPT_V2;
  });

  it("assembles the replacement prompt with mode replace for Claude sessions", () => {
    mgr.setExtensionPromptContributionsProvider(() => [
      {
        identity: "@example/ext",
        version: "1.0.0",
        health: "healthy",
        guidance: { purpose: "Example things" },
        capabilityPrefixes: ["example."],
      },
    ]);
    const message = mgr.buildSystemMessage({ sessionId: "claude-1" });
    expect(message.mode).toBe("replace");
    // Stable prefix: core first, then Claude tooling, host tools, runtime.
    expect(message.content.startsWith("# Marshal")).toBe(true);
    expect(message.content).toContain("setSessionTodos");
    expect(message.content).toContain("runtimeSearch");
    expect(message.content).toContain("## Role: orchestrating main session");
    // Dynamic extension contribution present.
    expect(message.content).toContain("@example/ext v1.0.0");
    expect(message.content).toContain("purpose: Example things");
    // Dedup: the legacy skills usage contract and memory-provenance guidance
    // must not ride in via the session tail.
    expect(message.content).not.toContain(
      "You MUST call getSkill(name) before executing ANY skill",
    );
    expect(message.content).not.toContain("## Memory Provenance");
  });

  it("builds the lean Claude prompt only for sessions stamped lean (env MARSHAL_LEAN_PROMPT=0 reverts)", () => {
    const rows = [
      { id: "claude-lean", runtimeId: "claude", source: "user", leanPrompt: true },
      { id: "claude-unstamped", runtimeId: "claude", source: "user" },
      { id: "claude-legacy", runtimeId: "claude", source: "user", leanPrompt: false },
      { id: "cursor-lean", runtimeId: "cursor", source: "user", leanPrompt: true },
    ];
    mgr.store.loadSessionData = (id: string) => rows.find((row) => row.id === id) ?? null;
    mgr.setExtensionPromptContributionsProvider(() => []);
    const buildingMarker = "## Building custom React UI (agent-authored, end to end)";

    const lean = mgr.buildSystemMessage({ sessionId: "claude-lean" });
    expect(lean.mode).toBe("replace");
    expect(lean.content).not.toContain(buildingMarker);
    expect(lean.content).toContain('getSkill {name: "runtime-ui-authoring"}');

    for (const id of ["claude-unstamped", "claude-legacy", "cursor-lean"]) {
      expect(mgr.buildSystemMessage({ sessionId: id }).content, id).toContain(buildingMarker);
    }

    process.env.MARSHAL_LEAN_PROMPT = "0";
    try {
      expect(mgr.buildSystemMessage({ sessionId: "claude-lean" }).content).toContain(
        buildingMarker,
      );
    } finally {
      delete process.env.MARSHAL_LEAN_PROMPT;
    }
  });

  it("applies leanCore and leanRepoRules independently, only to Claude sessions stamped with them (env kill switches revert)", () => {
    const rows = [
      { id: "claude-core", runtimeId: "claude", source: "user", leanCore: true },
      { id: "claude-rules", runtimeId: "claude", source: "user", leanRepoRules: true },
      { id: "claude-neither", runtimeId: "claude", source: "user" },
      {
        id: "cursor-both",
        runtimeId: "cursor",
        source: "user",
        leanCore: true,
        leanRepoRules: true,
      },
    ];
    mgr.store.loadSessionData = (id: string) => rows.find((row) => row.id === id) ?? null;
    mgr.setExtensionPromptContributionsProvider(() => []);
    const customizations = vi
      .spyOn(mgr.backend.sessions, "getRepositoryCustomizationsForSystemPrompt")
      .mockReturnValue("");
    const leanCoreHeading = "# Communicating: progress updates, final message, writing style";
    const legacyCoreHeading = "# Sharing progress updates";
    const optionsFor = (id: string) => {
      customizations.mockClear();
      const content: unknown = mgr.buildSystemMessage({ sessionId: id }).content;
      expect(typeof content).toBe("string");
      return { content: String(content), args: customizations.mock.calls[0] };
    };

    const core = optionsFor("claude-core");
    expect(core.content).toContain(leanCoreHeading);
    expect(core.content).not.toContain(legacyCoreHeading);
    expect(core.content).toContain("## Building custom React UI (agent-authored, end to end)");
    expect(core.args?.[1]).toBeUndefined();

    const rules = optionsFor("claude-rules");
    expect(rules.content).toContain(legacyCoreHeading);
    expect(rules.args?.[1]).toEqual({ lean: true });

    for (const id of ["claude-neither", "cursor-both"]) {
      const result = optionsFor(id);
      expect(result.content, id).toContain(legacyCoreHeading);
      expect(result.args?.[1], id).toBeUndefined();
    }

    process.env.MARSHAL_LEAN_CORE = "0";
    process.env.MARSHAL_LEAN_REPO_RULES = "0";
    try {
      expect(optionsFor("claude-core").content).toContain(legacyCoreHeading);
      expect(optionsFor("claude-rules").args?.[1]).toBeUndefined();
    } finally {
      delete process.env.MARSHAL_LEAN_CORE;
      delete process.env.MARSHAL_LEAN_REPO_RULES;
    }
  });

  it("assembles the replacement prompt with mode replace for Codex sessions, without Claude tooling", () => {
    const message = mgr.buildSystemMessage({ sessionId: "codex-1" });

    expect(message.mode).toBe("replace");
    expect(message.content.startsWith("# Marshal")).toBe(true);
    expect(message.content).toContain("setSessionTodos");
    expect(message.content).not.toContain("# Claude adapter block");
  });

  it("keeps Codex on the legacy composer when replacement is off", () => {
    delete process.env.MARSHAL_PROMPT_V2;
    const message = mgr.buildSystemMessage({ sessionId: "codex-1" });

    expect(message.mode).toBeUndefined();
    expect(message.content).toContain("You are an AI desktop assistant");
  });

  it("keeps Cursor on v2 append delivery even when replacement is enabled", () => {
    const message = mgr.buildSystemMessage({ sessionId: "cursor-1" });

    expect(message.mode).toBe("append");
    expect(message.content.startsWith("# Marshal")).toBe(true);
    expect(message.content).toContain("setSessionTodos");
    expect(message.content).toContain("runtimeSearch");
    expect(message.content).not.toContain("# Claude adapter block");
  });

  it("keeps the legacy composer for unsupported runtimes and Claude when the flag is off", () => {
    const copilot = mgr.buildSystemMessage({ sessionId: "copilot-1" });
    expect(copilot.mode).toBeUndefined();
    expect(copilot.content).toContain("You are an AI desktop assistant");

    delete process.env.MARSHAL_PROMPT_V2;
    const claudeOff = mgr.buildSystemMessage({ sessionId: "claude-1" });
    expect(claudeOff.mode).toBeUndefined();
    expect(claudeOff.content).toContain("You are an AI desktop assistant");
  });

  it("uses the updated Cursor prompt through append delivery when replacement is off", () => {
    delete process.env.MARSHAL_PROMPT_V2;

    const message = mgr.buildSystemMessage({ sessionId: "cursor-1" });

    expect(message.mode).toBe("append");
    expect(message.content.startsWith("# Marshal")).toBe(true);
    expect(message.content).toContain("setSessionTodos");
    expect(message.content).toContain("runtimeSearch");
    expect(message.content).not.toContain("You are an AI desktop assistant");
    expect(message.content).not.toContain("# Cursor SDK native tool operation");
  });

  it("refreshes updated Cursor prompt contributions while replacement is off", () => {
    delete process.env.MARSHAL_PROMPT_V2;
    mgr.setExtensionPromptContributionsProvider(() => []);
    mgr.sessionHandles.set("cursor-1", {});
    mgr.busyTracker.setBusy("cursor-1");

    mgr.onExtensionPromptContributionsChanged();

    expect(mgr.pendingPromptRefreshSessions.has("cursor-1")).toBe(true);
  });

  it("denies runtime/extension guidance to reviewer-mode sessions (per-session gating)", () => {
    mgr.setExtensionPromptContributionsProvider(() => [
      {
        identity: "@example/ext",
        version: "1.0.0",
        health: "healthy",
        capabilityPrefixes: ["example."],
      },
    ]);
    const message = mgr.buildSystemMessage({ sessionId: "claude-reviewer", isSubagent: true });
    expect(message.mode).toBe("replace");
    // Shared core retained (the audit's swarm-bypass fix)…
    expect(message.content).toContain("External content and untrusted input");
    // …but no runtime discovery, host-tool, or extension guidance the
    // reviewer cannot use (the behavior core may still NAME runtime tools in
    // its generic retrieval principle — section-specific sentinels only).
    expect(message.content).not.toContain("Full TypeScript execution");
    expect(message.content).not.toContain("setSessionTodos");
    expect(message.content).not.toContain("@example/ext");
  });

  it("extension enable/disable transitions rebuild the prompt content", () => {
    let health: "healthy" | "disabled" = "healthy";
    mgr.setExtensionPromptContributionsProvider(() => [
      {
        identity: "@toggle/ext",
        version: "2.0.0",
        health,
        capabilityPrefixes: ["toggle."],
      },
    ]);
    const enabled = mgr.buildSystemMessage({ sessionId: "claude-1" });
    expect(enabled.content).toContain("@toggle/ext");

    health = "disabled";
    const disabled = mgr.buildSystemMessage({ sessionId: "claude-1" });
    expect(disabled.content).not.toContain("@toggle/ext");
  });

  it("stays extension-neutral: no work-service sensitivity/scheduling text with filtered providers", () => {
    mgr.selfToolDeps = {
      ...(mgr.selfToolDeps ?? {}),
      settingsManager: mgr.selfToolDeps?.settingsManager ?? { get: () => ({}) },
      workServices: {
        communications: null,
        remoteFileStorage: null,
        collaboration: null,
        directory: null,
        notifications: { isAvailable: () => false },
        identity: null,
        actionSuggestions: null,
      },
    };
    const message = mgr.buildSystemMessage({ sessionId: "claude-1" });
    expect(message.mode).toBe("replace");
    expect(message.content).not.toContain("Sensitivity Labels");
    expect(message.content).not.toContain("Scheduling meetings");
    expect(message.content).not.toContain("listEmails");
    // Generic behavior text that merely mentions email as a data class stays.
    expect(message.content).toContain("External content");
  });

  it("never falls back to enabled when work-service deps are absent entirely", () => {
    // Undefined deps previously defaulted availability to TRUE, silently
    // resurrecting work-service guidance with no tools behind it.
    mgr.selfToolDeps = undefined;
    const message = mgr.buildSystemMessage({ sessionId: "claude-1" });
    expect(message.mode).toBe("replace");
    expect(message.content).not.toContain("Sensitivity Labels");
    expect(message.content).not.toContain("Scheduling meetings");
  });

  /**
   * Integration seam for the Claude SDK options, replacing what a mock-mode
   * boot cannot prove: resolveRuntimeStartupSelection pins the copilot runtime
   * under MARSHAL_E2E (electron/backend/startup-selection.ts), so an isolated
   * E2E boot can never exercise the Claude adapter. This test runs the REAL
   * production chain instead — SessionManager assembly → the local wrapper's
   * toRuntimeSystemMessage + config-trace builder → the actual Claude
   * toClaudeQueryOptions — and asserts the byte-identical assembled prompt
   * reaches the SDK options as a full custom string on create AND resume,
   * with no model call anywhere.
   */
  it("carries the assembled prompt byte-identical into the Claude SDK options (create + resume)", async () => {
    const message = mgr.buildSystemMessage({ sessionId: "claude-1" });
    expect(message.mode).toBe("replace");
    expect(message.content.length).toBeGreaterThan(40_000);

    const { toRuntimeSystemMessage, buildSessionConfigTrace } =
      await import("./backend/local/session");
    const systemMessage = toRuntimeSystemMessage(message.content, message.mode);
    expect(systemMessage).toEqual({ content: message.content, mode: "replace" });

    // The production evidence surface (session-config trace) records the real
    // mode — never the hardcoded "append" it carried before this project.
    const trace = buildSessionConfigTrace({
      sessionId: "claude-1",
      operation: "createSession",
      model: "claude-sonnet-5",
      reasoningEffort: undefined,
      contextTier: undefined,
      effectiveWorkspaceDir: "/test/workspace",
      tools: [],
      mcpServers: {},
      systemMessage: message.content,
      systemMessageMode: message.mode,
      sessionSource: undefined,
      availableTools: undefined,
      systemMessageProfile: "marshal-full",
      hasRepositoryAgent: false,
    });
    expect(trace.systemMessage).toMatchObject({
      mode: "replace",
      chars: message.content.length,
    });

    const { toClaudeQueryOptions } = await import("./backend/claude/config");
    const { ClaudeToolInvocationRegistry } = await import("./backend/claude/tool-invocations");
    const base = {
      client: { workspaceDir: "/test/workspace", env: { PATH: "bin" } },
      config: {
        clientName: "marshal/test",
        model: "claude-sonnet-5",
        streaming: true,
        includeSubAgentStreamingEvents: false,
        workingDirectory: "/test/workspace",
        systemMessage,
      },
      sessionId: "11111111-1111-4111-8111-111111111111",
      toolAliases: {},
      invocations: new ClaudeToolInvocationRegistry(),
    };
    const created = toClaudeQueryOptions({ ...base, resume: false });
    const resumed = toClaudeQueryOptions({ ...base, resume: true });
    // Full custom string — NOT the {type: "preset"} object — on both paths.
    expect(created.systemPrompt).toBe(message.content);
    expect(resumed.systemPrompt).toBe(message.content);
    // Tool surface stays independent of the prompt mode: no allowlist was
    // given, so the adapter leaves the built-in tool preset unrestricted.
    expect(created.allowedTools).toBeUndefined();
    expect(created.skills).toBe("all");
  });
});

describe("refreshSession onlyWhenIdle (H2 regression)", () => {
  let mgr: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const fsMock = vi.mocked(await import("fs"));
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readdirSync.mockReturnValue([]);
    fsMock.readFileSync.mockReturnValue("{}");
    const { SessionManager } = await import("./sessions");
    mgr = new SessionManager("/test/workspace", await createTestBackend());
    mgr.store.loadSessionData = () => ({ id: "s1", runtimeId: "claude" });
    mgr.sessionHandles.set("s1", {});
    mgr.backend.sessions.applyConfigChange = async (_id: string, recreate: () => Promise<void>) =>
      recreate();
    mgr.backend.sessions.disconnect = vi.fn<() => Promise<void>>(async () => {});
    mgr.createBackendSession = vi.fn<() => Promise<void>>(async () => {});
  });

  it("aborts without teardown when a queued turn wins the dispatch lock", async () => {
    // The caller observed idle, but a turn starts before the refresh acquires
    // the lock: the serialized re-check must abort — no disconnect, no
    // collection interruption — and report false so the caller requeues.
    mgr.busyTracker.setBusy("s1");
    const applied = await mgr.refreshSession("s1", { onlyWhenIdle: true });
    expect(applied).toBe(false);
    expect(mgr.backend.sessions.disconnect).not.toHaveBeenCalled();
    expect(mgr.createBackendSession).not.toHaveBeenCalled();
  });

  it("performs the refresh when genuinely idle", async () => {
    const applied = await mgr.refreshSession("s1", { onlyWhenIdle: true });
    expect(applied).toBe(true);
    expect(mgr.backend.sessions.disconnect).toHaveBeenCalledTimes(1);
    expect(mgr.createBackendSession).toHaveBeenCalledTimes(1);
  });

  it("requeues a pending prompt refresh when the idle drain loses the race", async () => {
    process.env.MARSHAL_PROMPT_V2 = "1";
    mgr.setExtensionPromptContributionsProvider(() => []);
    vi.useFakeTimers();
    try {
      // Extensions changed while busy → marked pending.
      mgr.busyTracker.setBusy("s1");
      mgr.onExtensionPromptContributionsChanged();
      expect(mgr.pendingPromptRefreshSessions.has("s1")).toBe(true);

      // Turn ends → drain schedules; but a new turn wins before the timer.
      mgr.busyTracker.setIdle("s1");
      mgr.busyTracker.setBusy("s1");
      await vi.advanceTimersByTimeAsync(300);
      // Still pending (requeued), and no teardown happened mid-turn.
      expect(mgr.pendingPromptRefreshSessions.has("s1")).toBe(true);
      expect(mgr.backend.sessions.disconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      delete process.env.MARSHAL_PROMPT_V2;
    }
  });
});

describe("availability guidance follows the tool surface (H1 residual)", () => {
  it("reviewer-mode sessions get no browser/scheduling instructions but keep visualization prose", async () => {
    vi.clearAllMocks();
    const fsMock = vi.mocked(await import("fs"));
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readdirSync.mockReturnValue([]);
    fsMock.readFileSync.mockReturnValue("{}");
    const { SessionManager } = await import("./sessions");
    const mgr: any = new SessionManager("/test/workspace", await createTestBackend());
    const rows = [
      {
        id: "claude-reviewer",
        runtimeId: "claude",
        source: "subagent",
        permissionMode: "read-only-reviewer",
        runtimeAgentRole: "reviewer",
      },
    ];
    mgr.store.loadIndex = () => ({ sessions: rows });
    mgr.store.loadSessionData = (id: string) => rows.find((r) => r.id === id) ?? null;
    process.env.MARSHAL_PROMPT_V2 = "1";
    try {
      const message = mgr.buildSystemMessage({ sessionId: "claude-reviewer", isSubagent: true });
      expect(message.content).not.toContain("Browser Control and Web Browsing");
      expect(message.content).not.toContain("Scheduling meetings");
      expect(message.content).toContain("## Visualizations");
    } finally {
      delete process.env.MARSHAL_PROMPT_V2;
    }
  });
});
