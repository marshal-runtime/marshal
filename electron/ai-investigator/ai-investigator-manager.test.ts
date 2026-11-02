import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AIInvestigatorEvent, PermissionsConfig } from "../../common/marshal-ipc-contract";
import { resolveIssueReporterTarget } from "../issue-reporter/config";
import {
  buildFallbackIssueUrl,
  createGitHubIssueReporter,
  type GhRunner,
} from "../issue-reporter/github-provider";
import type { SendAndCollectResult } from "../sessions";
import {
  AIInvestigatorManager,
  type AIInvestigatorManagerDeps,
} from "./ai-investigator-manager";

// The manager is destination-agnostic; these tests drive it through the real
// GitHub adapter with a fake `gh` runner. `setIssueTarget` lets individual
// tests opt into the unconfigured / malformed-target paths.
let issueTargetSetting: string | undefined = "owner/repo";
function setIssueTarget(value: string | undefined): void {
  issueTargetSetting = value;
}

vi.mock("electron", () => ({
  shell: {
    openExternal: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
  },
}));

const REPORT = [
  "# Crash on Heartbeat settings open",
  "",
  "## Summary",
  "Clicking the Heartbeat tab throws a TypeError.",
  "",
  "## Suspected cause",
  "Likely a missing null guard in HeartbeatSettings.tsx.",
  "",
  "## Reproduction steps",
  "1. Open the app",
  "2. Click Heartbeat",
  "",
  "## Diagnostics excerpt",
  "```",
  "ERROR foo",
  "```",
].join("\n");

interface Harness {
  manager: AIInvestigatorManager;
  events: AIInvestigatorEvent[];
  registerSessionPermissions: ReturnType<typeof vi.fn>;
  unregisterSessionPermissions: ReturnType<typeof vi.fn>;
  setDenyPrompt: ReturnType<typeof vi.fn>;
  clearDenyPrompt: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  sendAndCollect: ReturnType<typeof vi.fn>;
  abortSession: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  gh: GhRunner;
}

function setup(
  overrides: {
    reportText?: string;
    diagnostics?: string;
    ghIsAvailable?: boolean;
    ghCanAccessRepo?: boolean;
    createIssueImpl?: GhRunner["createIssue"];
    sendAndCollectImpl?: (
      prompt: string,
      timeoutMs: number,
      observer: (event: { type: string; status?: string }) => void,
      sessionId: string,
    ) => Promise<SendAndCollectResult>;
  } = {},
): Harness {
  const events: AIInvestigatorEvent[] = [];
  const registerSessionPermissions = vi.fn<(id: string, perms: PermissionsConfig) => void>();
  const unregisterSessionPermissions = vi.fn<(id: string) => void>();
  const setDenyPrompt = vi.fn<(id: string) => void>();
  const clearDenyPrompt = vi.fn<(id: string) => void>();
  const createSession = vi
    .fn<(input: unknown) => Promise<{ id: string; source: string }>>()
    .mockResolvedValue({ id: "ai-investigator-session-1", source: "feedback" });
  // Real signature: (prompt, timeoutMs, observer, sessionId). Default impl
  // resolves immediately with the canned report so happy-path tests stay
  // simple; override via `sendAndCollectImpl` to exercise observer/error paths.
  const sendAndCollect = vi
    .fn<
      (
        prompt: string,
        timeoutMs: number,
        observer: (event: { type: string; status?: string }) => void,
        sessionId: string,
      ) => Promise<SendAndCollectResult>
    >()
    .mockImplementation(
      overrides.sendAndCollectImpl ??
        (async () => ({ kind: "ok", text: overrides.reportText ?? REPORT })),
    );
  const abortSession = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
  const deleteSession = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
  const gh: GhRunner = {
    isAvailable: vi
      .fn<GhRunner["isAvailable"]>()
      .mockResolvedValue(overrides.ghIsAvailable ?? true),
    canAccessRepo: vi
      .fn<GhRunner["canAccessRepo"]>()
      .mockResolvedValue(overrides.ghCanAccessRepo ?? true),
    createIssue:
      overrides.createIssueImpl ??
      vi
        .fn<GhRunner["createIssue"]>()
        .mockResolvedValue("https://github.com/OmerMachluf/marshal/issues/9999"),
  };
  const deps: AIInvestigatorManagerDeps = {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial mock used only by AIInvestigatorManager paths exercised in this test
    sessionManager: {
      createSession,
      sendAndCollect,
      abortSession,
      deleteSession,
    } as unknown as AIInvestigatorManagerDeps["sessionManager"],
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial mock; only the four registered methods are called
    permissionPolicy: {
      registerSessionPermissions,
      unregisterSessionPermissions,
      setDenyPrompt,
      clearDenyPrompt,
    } as unknown as AIInvestigatorManagerDeps["permissionPolicy"],
    getDiagnosticsTail: () => overrides.diagnostics ?? "ERROR foo",
    emit: (e) => events.push(e),
    issueReporter: createGitHubIssueReporter({
      getTarget: () => resolveIssueReporterTarget({ target: issueTargetSetting }),
      ghRunner: gh,
    }),
  };
  return {
    manager: new AIInvestigatorManager(deps),
    events,
    registerSessionPermissions,
    unregisterSessionPermissions,
    setDenyPrompt,
    clearDenyPrompt,
    createSession,
    sendAndCollect,
    abortSession,
    deleteSession,
    gh,
  };
}

describe("AIInvestigatorManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to the populated default; tests covering the absent-setting
    // path call `setIssueTarget(undefined)` after.
    setIssueTarget("owner/repo");
  });

  it("starts in idle state", () => {
    const { manager } = setup();
    expect(manager.getStatus().state).toBe("idle");
  });

  it("walks through collecting → investigating → ready", async () => {
    const h = setup();
    await h.manager.start({ userDescription: "thing broke" });
    // wait a tick for the async run promise
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const states = h.events.filter((e) => e.type === "status").map((e) => e.state);
    expect(states).toContain("collecting");
    expect(states).toContain("investigating");
    expect(states).toContain("ready");
    const status = h.manager.getStatus();
    expect(status.state).toBe("ready");
    expect(status.title).toBe("Crash on Heartbeat settings open");
    expect(status.body).toContain("## Summary");
  });

  it("prepends the user's original description as a quoted section", async () => {
    const h = setup();
    await h.manager.start({ userDescription: "Heartbeat crashes when I open settings" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const body = h.manager.getStatus().body ?? "";
    expect(body).toMatch(/^## Original report\s*\n\s*> Heartbeat crashes when I open settings/);
    // The investigator's own report still follows after the separator.
    expect(body).toContain("---");
    expect(body).toContain("## Summary");
  });

  it("preserves multi-line user descriptions as a contiguous blockquote", async () => {
    const h = setup();
    await h.manager.start({ userDescription: "line one\nline two\nline three" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const body = h.manager.getStatus().body ?? "";
    expect(body).toContain("> line one\n> line two\n> line three");
  });

  it("omits the Original report section when description is empty", async () => {
    const h = setup();
    await h.manager.start({ userDescription: "   " });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const body = h.manager.getStatus().body ?? "";
    expect(body).not.toContain("## Original report");
    expect(body).toContain("## Summary");
  });

  it("registers tight permissions and sets deny-prompt on the hidden session", async () => {
    const h = setup();
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.createSession).toHaveBeenCalledWith(undefined, undefined, {
      source: "feedback",
      setActive: false,
    });
    expect(h.registerSessionPermissions).toHaveBeenCalledWith(
      "ai-investigator-session-1",
      expect.objectContaining({
        autoApproveReadOnly: false,
        // Code-investigation focused: only `gh search code/commits`,
        // `gh repo view`, and the scoped REST API. NO issue/pr triage.
        allow: expect.arrayContaining([
          "gh search code*",
          "gh search commits*",
          "gh repo view*",
          "gh api repos/owner/repo/*",
        ]),
      }),
    );
    // The locked-down allowlist must NOT include destructive verbs, the
    // unrestricted `gh *` wildcard, OR issue-tracker browsing commands
    // (which would let the model waste budget on duplicate-hunting
    // instead of code investigation).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- vi.fn mock.calls is typed as any[][]
    const perms = h.registerSessionPermissions.mock.calls[0][1] as PermissionsConfig;
    const allowList = perms.allow ?? [];
    expect(allowList).not.toContain("gh *");
    expect(allowList.every((p) => p.startsWith("gh "))).toBe(true);
    // Issue-tracker commands MUST be absent (refocus on code, not triage).
    for (const banned of [
      "gh issue list*",
      "gh issue view*",
      "gh issue status*",
      "gh pr list*",
      "gh pr view*",
      "gh pr diff*",
      "gh search issues*",
      "gh search prs*",
      "gh search repos*",
    ]) {
      expect(allowList).not.toContain(banned);
    }
    expect(perms.servers.filesystem?.enabled).toBe(false);
    expect(perms.servers.playwright?.enabled).toBe(false);
    expect(perms.servers.shell?.enabled).toBe(true);
    expect(perms.servers.shell?.autoApprove).toBe(false);
    // gh api is allowed but only scoped to the configured repo target, and
    // method-mutating flags are explicitly denied so the model can't smuggle
    // `-X DELETE` after the path positional.
    expect(allowList).toContain("gh api repos/owner/repo/*");
    const denyList = perms.denyPatterns ?? [];
    expect(denyList).toEqual(
      expect.arrayContaining([
        "gh api * -X*",
        "gh api *--method*",
        "gh api * -F*",
        "gh api *--field*",
      ]),
    );
    expect(h.setDenyPrompt).toHaveBeenCalledWith("ai-investigator-session-1");
    expect(h.unregisterSessionPermissions).toHaveBeenCalledWith("ai-investigator-session-1");
    expect(h.clearDenyPrompt).toHaveBeenCalledWith("ai-investigator-session-1");
  });

  it("posts via gh when available", async () => {
    const h = setup({ ghIsAvailable: true });
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    const result = await h.manager.post();
    expect(result.success).toBe(true);
    expect(result.url).toBe("https://github.com/OmerMachluf/marshal/issues/9999");
    expect(h.gh.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Crash on Heartbeat settings open",
      }),
    );
    expect(h.manager.getStatus().state).toBe("posted");
  });

  it("falls back to a browser URL when gh is missing", async () => {
    const h = setup({ ghIsAvailable: false });
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    const result = await h.manager.post();
    expect(result.success).toBe(true);
    expect(result.fallbackUrl).toMatch(/^https:\/\/github\.com\/owner\/repo\/issues\/new\?/);
    expect(h.manager.getStatus().fallbackUrl).toBe(result.fallbackUrl);
    expect(h.manager.getStatus().state).toBe("posted");
  });

  it("falls back to a browser URL when gh createIssue throws", async () => {
    const h = setup({
      ghIsAvailable: true,
      createIssueImpl: vi.fn<GhRunner["createIssue"]>().mockRejectedValue(new Error("boom")),
    });
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    const result = await h.manager.post();
    expect(result.success).toBe(true);
    expect(result.fallbackUrl).toBeDefined();
  });

  describe("checkAvailability", () => {
    it("returns available=true when gh is installed and the repo is reachable", async () => {
      const h = setup({ ghIsAvailable: true, ghCanAccessRepo: true });
      const res = await h.manager.checkAvailability();
      expect(res).toEqual({ available: true });
    });

    it("returns available=false with a reason when gh is missing", async () => {
      const h = setup({ ghIsAvailable: false, ghCanAccessRepo: true });
      const res = await h.manager.checkAvailability();
      expect(res.available).toBe(false);
      expect(res.reason).toMatch(/gh CLI/);
    });

    it("returns available=false with a reason when the repo is unreachable", async () => {
      const h = setup({ ghIsAvailable: true, ghCanAccessRepo: false });
      const res = await h.manager.checkAvailability();
      expect(res.available).toBe(false);
      expect(res.reason).toMatch(/owner\/repo/);
    });

    it("memoizes the probe result", async () => {
      const h = setup({ ghIsAvailable: true, ghCanAccessRepo: true });
      await h.manager.checkAvailability();
      await h.manager.checkAvailability();
      // Each probe calls isAvailable + canAccessRepo exactly once.
      expect(h.gh.isAvailable).toHaveBeenCalledTimes(1);
      expect(h.gh.canAccessRepo).toHaveBeenCalledTimes(1);
    });

    it("returns available=false when no issue destination is configured", async () => {
      setIssueTarget(undefined);
      const h = setup({ ghIsAvailable: true, ghCanAccessRepo: true });
      const res = await h.manager.checkAvailability();
      expect(res.available).toBe(false);
      expect(res.reason).toMatch(/no issue destination is configured/i);
      // gh probes should be short-circuited — the feature is unavailable
      // before we ever consult `gh`.
      expect(h.gh.isAvailable).not.toHaveBeenCalled();
      expect(h.gh.canAccessRepo).not.toHaveBeenCalled();
    });

    it("returns available=false when the target fails owner/repo format validation", async () => {
      setIssueTarget("../traversal/attempt");
      const h = setup({ ghIsAvailable: true, ghCanAccessRepo: true });
      const res = await h.manager.checkAvailability();
      expect(res.available).toBe(false);
    });
  });

  it("re-entry while investigating does NOT spawn a second session", async () => {
    const h = setup();
    // Make sendAndCollect hang so we stay in `investigating`.
    let resolveRun!: (val: { kind: string; text: string }) => void;
    h.sendAndCollect.mockImplementation(
      () => new Promise((r) => (resolveRun = r as typeof resolveRun)),
    );
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    await h.manager.start({ userDescription: "y again" });
    expect(h.createSession).toHaveBeenCalledTimes(1);
    // Description from the first call should still be in place.
    expect(h.manager.getStatus().userDescription).toBe("x");
    resolveRun({ kind: "ok", text: REPORT });
  });

  it("synthesizes title from user description when investigator returns no H1 (no longer errors)", async () => {
    const h = setup({ reportText: "just some plain text without a header" });
    await h.manager.start({ userDescription: "Heartbeat keeps crashing" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const status = h.manager.getStatus();
    // Used to throw "Investigator did not produce a structured report" — now
    // we always produce a draft so the user doesn't lose 2–3 minutes of work.
    expect(status.state).toBe("ready");
    expect(status.title).toBe("AI investigation: Heartbeat keeps crashing");
    expect(status.body).toContain("just some plain text without a header");
  });

  it("hard-errors only when the investigator times out with empty text", async () => {
    const h = setup({
      sendAndCollectImpl: async () => ({ kind: "timeout", text: "   " }),
    });
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const status = h.manager.getStatus();
    expect(status.state).toBe("error");
    expect(status.error).toMatch(/timed out/i);
  });

  it("preserves a partial timeout response as a ready draft", async () => {
    const h = setup({
      sendAndCollectImpl: async () => ({
        kind: "timeout",
        text: "Partial body before timeout fired.",
      }),
    });
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const status = h.manager.getStatus();
    expect(status.state).toBe("ready");
    expect(status.title).toBe("AI investigation: x");
    expect(status.body).toContain("Partial body before timeout fired.");
  });

  it("keeps an empty no-response result as a ready placeholder draft", async () => {
    const h = setup({
      sendAndCollectImpl: async () => ({ kind: "no-response", text: "" }),
    });
    await h.manager.start({ userDescription: "Heartbeat keeps crashing" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const status = h.manager.getStatus();
    expect(status.state).toBe("ready");
    expect(status.title).toBe("AI investigation: Heartbeat keeps crashing");
    expect(status.body).toContain("(no investigation report produced)");
  });

  it("rejects post() when not in ready state", async () => {
    const h = setup();
    const r = await h.manager.post();
    expect(r.success).toBe(false);
  });

  it("includes the sanitized diagnostics tail in the issue body posted via gh", async () => {
    const h = setup({
      ghIsAvailable: true,
      diagnostics: "ERROR distinctive_marker_xyz boom",
    });
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await h.manager.post();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- vi.fn mock.calls is typed as any[][]
    const arg = (h.gh.createIssue as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      body: string;
    };
    expect(arg.body).toContain("<details>");
    expect(arg.body).toContain("Full diagnostics tail");
    expect(arg.body).toContain("distinctive_marker_xyz");
    expect(arg.body).toContain("</details>");
  });

  it("includes the sanitized diagnostics tail in the fallback URL body", async () => {
    const h = setup({
      ghIsAvailable: false,
      diagnostics: "ERROR fallback_marker_abc",
    });
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const result = await h.manager.post();
    expect(result.fallbackUrl).toBeDefined();
    const url = new URL(result.fallbackUrl!);
    const body = url.searchParams.get("body") ?? "";
    expect(body).toContain("fallback_marker_abc");
    expect(body).toContain("<details>");
  });

  it("omits the diagnostics <details> block when the tail is empty", async () => {
    const h = setup({ ghIsAvailable: true, diagnostics: "" });
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await h.manager.post();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- vi.fn mock.calls is typed as any[][]
    const arg = (h.gh.createIssue as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      body: string;
    };
    expect(arg.body).not.toContain("<details>");
    expect(arg.body).not.toContain("Full diagnostics tail");
  });

  it("threads the ai-investigator session id as the 4th sendAndCollect arg", async () => {
    const h = setup();
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    // Real signature is (prompt, timeoutMs, observer, sessionId).
    expect(h.sendAndCollect.mock.calls[0][3]).toBe("ai-investigator-session-1");
  });

  it("forwards turn:status events from the observer into the progress log", async () => {
    const h = setup({
      sendAndCollectImpl: async (_p, _t, observer) => {
        observer({ type: "turn:status", status: "Searching issues…" });
        return { kind: "ok", text: REPORT };
      },
    });
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const messages = h.manager.getStatus().log.map((e) => e.message);
    expect(messages).toContain("Searching issues…");
  });

  it("preserves a multi-KB body through post() without truncation", async () => {
    // Build a structured report whose body exceeds the 4096-char telemetry cap.
    const huge = "lorem ipsum ".repeat(600); // ~7.2 KB body
    const report = `# TITLE\nVery serious bug\n\n# BODY\n## Summary\n${huge}\n`;
    const h = setup({ reportText: report });
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const status = h.manager.getStatus();
    expect(status.body).toBeDefined();
    // Body should not have been truncated by sanitizeForTelemetry's 4096 cap.
    expect((status.body ?? "").length).toBeGreaterThan(5000);
    expect(status.body).not.toContain("[truncated]");

    await h.manager.post();
    // gh path: title + full body delivered to createIssue.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- vi.fn mock.calls is loosely typed; we know the real shape from the test setup
    const call = (h.gh.createIssue as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { title: string; body: string }
      | undefined;
    expect(call).toBeDefined();
    expect(call!.body.length).toBeGreaterThan(5000);
    expect(call!.body).not.toContain("[truncated]");
  });

  it("runs cleanup when sendAndCollect rejects (try/finally)", async () => {
    const h = setup({
      sendAndCollectImpl: async () => {
        throw new Error("collect blew up");
      },
    });
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.unregisterSessionPermissions).toHaveBeenCalledWith("ai-investigator-session-1");
    expect(h.clearDenyPrompt).toHaveBeenCalledWith("ai-investigator-session-1");
    expect(h.deleteSession).toHaveBeenCalledWith("ai-investigator-session-1", {
      cause: "investigator",
    });
    expect(h.manager.getStatus().state).toBe("error");
  });

  it("deleteSession is called for the ghost session on the happy path too", async () => {
    const h = setup();
    await h.manager.start({ userDescription: "x" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.deleteSession).toHaveBeenCalledWith("ai-investigator-session-1", {
      cause: "investigator",
    });
  });

  it("cancel() aborts the SDK session and a stale resolution does not clobber state", async () => {
    let resolveFirst!: (val: SendAndCollectResult) => void;
    const h = setup({
      sendAndCollectImpl: () =>
        new Promise<SendAndCollectResult>((r) => {
          resolveFirst = r;
        }),
    });

    await h.manager.start({ userDescription: "first" });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.manager.getStatus().state).toBe("investigating");

    await h.manager.cancel();
    expect(h.abortSession).toHaveBeenCalledWith("ai-investigator-session-1");
    expect(h.manager.getStatus().state).toBe("error");
    expect(h.manager.getStatus().error).toBe("Cancelled by user");

    // Late resolution from the cancelled run must be ignored — state must
    // not flip back to "ready" or pick up the cancelled run's report.
    resolveFirst({ kind: "ok", text: REPORT });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.manager.getStatus().state).toBe("error");
  });

  describe("reset()", () => {
    it("returns to idle and clears all fields after a completed run", async () => {
      const h = setup();
      await h.manager.start({ userDescription: "broken thing" });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(h.manager.getStatus().state).toBe("ready");

      h.manager.reset();
      const s = h.manager.getStatus();
      expect(s.state).toBe("idle");
      expect(s.userDescription).toBe("");
      expect(s.title).toBeUndefined();
      expect(s.body).toBeUndefined();
      expect(s.issueUrl).toBeUndefined();
      expect(s.fallbackUrl).toBeUndefined();
      expect(s.error).toBeUndefined();
      expect(s.log).toHaveLength(0);
    });

    it("emits an idle status event on reset", async () => {
      const h = setup();
      await h.manager.start({ userDescription: "x" });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      h.events.length = 0; // clear prior events

      h.manager.reset();
      const statusEvents = h.events.filter((e) => e.type === "status");
      expect(statusEvents.at(-1)).toEqual({ type: "status", state: "idle" });
    });

    it("no-ops silently when a run is in-flight (collecting)", async () => {
      let resolve!: (val: SendAndCollectResult) => void;
      const h = setup({
        sendAndCollectImpl: () =>
          new Promise<SendAndCollectResult>((r) => {
            resolve = r;
          }),
      });
      await h.manager.start({ userDescription: "x" });
      await new Promise((r) => setTimeout(r, 0));

      h.manager.reset();
      expect(h.manager.getStatus().state).not.toBe("idle");
      resolve({ kind: "ok", text: REPORT });
    });

    it("bumps nonce so a stale sendAndCollect resolution after reset does not mutate state", async () => {
      let resolveRun!: (val: SendAndCollectResult) => void;
      const h = setup({
        sendAndCollectImpl: () =>
          new Promise<SendAndCollectResult>((r) => {
            resolveRun = r;
          }),
      });

      await h.manager.start({ userDescription: "first" });
      await new Promise((r) => setTimeout(r, 0));
      // At this point the run is in-flight; cancel first so reset is allowed.
      await h.manager.cancel();
      h.manager.reset();
      expect(h.manager.getStatus().state).toBe("idle");

      // Stale resolution should be silently discarded.
      resolveRun({ kind: "ok", text: REPORT });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(h.manager.getStatus().state).toBe("idle");
    });
  });

  describe("availability caching across post()", () => {
    it("reuses checkAvailability result so gh.isAvailable is called only once for checkAvailability + post", async () => {
      const h = setup({ ghIsAvailable: true });
      // Warm the cache.
      await h.manager.checkAvailability();
      expect(h.gh.isAvailable).toHaveBeenCalledTimes(1);

      // Run to ready state and post.
      await h.manager.start({ userDescription: "x" });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await h.manager.post();

      // post() must reuse the cached availability — no second probe.
      expect(h.gh.isAvailable).toHaveBeenCalledTimes(1);
    });

    it("re-probes after reset()", async () => {
      const h = setup({ ghIsAvailable: true });
      await h.manager.checkAvailability();
      expect(h.gh.isAvailable).toHaveBeenCalledTimes(1);

      h.manager.reset();
      await h.manager.checkAvailability();
      // Cache was cleared by reset — should probe again.
      expect(h.gh.isAvailable).toHaveBeenCalledTimes(2);
    });
  });

  describe("user description PII handling (W3c)", () => {
    it("redacts PII in the description but does NOT truncate a 6KB description in the issue body", async () => {
      const pii = "user@example.com";
      const filler = "x".repeat(6000);
      const longDesc = `${pii} ${filler}`;
      const h = setup({ ghIsAvailable: true });
      await h.manager.start({ userDescription: longDesc });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(h.manager.getStatus().state).toBe("ready");

      await h.manager.post();

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- vi.fn mock.calls is typed as any[][]
      const arg = (h.gh.createIssue as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        title: string;
        body: string;
      };
      // Email redacted, full-length description not truncated.
      expect(arg.body).toContain("<email>");
      expect(arg.body).not.toContain("user@example.com");
      // 6KB worth of filler must be present (no 4096-char truncation).
      expect(arg.body.length).toBeGreaterThan(5000);
      expect(arg.body).not.toContain("[truncated]");
    });

    it("redacted description is also present in the fallback URL body", async () => {
      const pii = "user@example.com";
      const filler = "y".repeat(100); // keep small for URL
      const longDesc = `${pii} ${filler}`;
      const h = setup({ ghIsAvailable: false });
      await h.manager.start({ userDescription: longDesc });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const result = await h.manager.post();
      const url = new URL(result.fallbackUrl!);
      const body = url.searchParams.get("body") ?? "";
      expect(body).toContain("<email>");
      expect(body).not.toContain("user@example.com");
    });
  });
});

describe("buildFallbackIssueUrl", () => {
  it("encodes title and body into the new-issue URL", () => {
    const url = buildFallbackIssueUrl("Hello world", "Body content", "owner/repo");
    expect(url).toContain("https://github.com/owner/repo/issues/new?");
    expect(url).toContain("title=Hello+world");
    expect(url).toContain("body=Body+content");
  });

  it("truncates oversized bodies", () => {
    const huge = "x".repeat(20_000);
    const url = buildFallbackIssueUrl("t", huge, "owner/repo");
    // URL itself stays well under typical browser limits (<8KB total body chunk).
    expect(url.length).toBeLessThan(20_000);
    expect(url).toContain("truncated");
  });
});
