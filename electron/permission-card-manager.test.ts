import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { PermissionCardData } from "../common/marshal-ipc-contract";
import { ApprovalBroker, type BrokerRequest } from "./approval-broker";
import type { ApprovalRequest } from "./backend/types";
import { PermissionCardManager } from "./permission-card-manager";
import type { PendingPermissionPrompt } from "./permission-card-manager";
import { formatPermissionDialog } from "./permissions";
import type { SessionManager } from "./sessions";
import { testDouble } from "./testing/harness";

/** Flush microtasks so async handlePending completes after broker.requestPrompt */
const flush = () =>
  new Promise<void>((r) => {
    queueMicrotask(r);
  });

vi.mock("electron", () => ({
  BrowserWindow: vi.fn<() => void>(),
}));

vi.mock("./permissions", () => ({
  formatPermissionDialog: vi
    .fn<() => Promise<{ title: string; message: string; detail: string }>>()
    .mockResolvedValue({ title: "Test Title", message: "Test message", detail: "test detail" }),
  truncateMiddle: vi.fn<(s: string) => string>((s: string) => s),
}));

function makePrompt(
  id: string,
  overrides: Partial<PendingPermissionPrompt> = {},
): PendingPermissionPrompt {
  return {
    id,
    toolCallId: `tc-${id}`,
    sessionId: "session-A",
    kind: "shell",
    title: `Run command ${id}`,
    message: "wants to run a command",
    detail: `echo ${id}`,
    buttons: ["Allow", "Deny"],
    ...overrides,
  };
}

function makeCard(id: string, overrides: Partial<PermissionCardData> = {}): PermissionCardData {
  return {
    id,
    kind: "shell",
    title: `Run command ${id}`,
    message: "wants to run a command",
    detail: `echo ${id}`,
    buttons: ["Allow", "Deny"],
    ...overrides,
  };
}

function createManager() {
  const mockWindow = {
    isDestroyed: vi.fn<() => boolean>().mockReturnValue(false),
    flashFrame: vi.fn<(flag: boolean) => void>(),
    webContents: { send: vi.fn<(channel: string, ...args: unknown[]) => void>() },
  };
  const mockSessionManager = {
    addEventListener: vi.fn<(listener: (sid: string, event: unknown) => void) => () => void>(
      () => () => {},
    ),
    savePermissionCards: vi.fn<(id: string, cards: PermissionCardData[]) => void>(),
    getSession: vi.fn<(id: string) => { permissionCards?: PermissionCardData[] } | null>(
      () => null,
    ),
    getPermissionPromptSessionId: vi.fn<(id: string) => string>((id) => id),
    getWorkspaceRootForSession: vi.fn<(id?: string) => string | undefined>(() => undefined),
  };
  const manager = new PermissionCardManager({
    getWindow: () => testDouble<import("electron").BrowserWindow>(mockWindow),
    sessionManager: testDouble<SessionManager>(mockSessionManager),
  });
  return { manager, mockWindow, mockSessionManager };
}

describe("PermissionCardManager", () => {
  let manager: PermissionCardManager;
  let mockWindow: ReturnType<typeof createManager>["mockWindow"];
  let mockSessionManager: ReturnType<typeof createManager>["mockSessionManager"];

  beforeEach(() => {
    ({ manager, mockWindow, mockSessionManager } = createManager());
  });

  // ── addCard ────────────────────────────────────────────────────────────

  it("addCard creates a card with createdAt", async () => {
    manager.addCard(makePrompt("p1"));
    const cards = manager.getCards("session-A");
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("p1");
    expect(cards[0].createdAt).toBeTypeOf("number");
  });

  it("addCard pushes to renderer", async () => {
    manager.addCard(makePrompt("p1"));
    expect(mockWindow.webContents.send).toHaveBeenCalledWith("permissions:cards-changed", {
      sessionId: "session-A",
      cards: expect.arrayContaining([expect.objectContaining({ id: "p1" })]),
    });
  });

  it("addCard persists to disk", async () => {
    manager.addCard(makePrompt("p1"));
    expect(mockSessionManager.savePermissionCards).toHaveBeenCalledWith(
      "session-A",
      expect.arrayContaining([expect.objectContaining({ id: "p1" })]),
    );
  });

  it.each([
    [
      "URL permission",
      {
        id: "req-url",
        sessionId: "session-A",
        kind: "url",
        url: "https://example.com",
        toolName: "browser_navigate",
        toolCallId: undefined,
      } satisfies ApprovalRequest,
      true,
    ],
    [
      "Playwright server browser tool",
      {
        id: "req-browser-click",
        sessionId: "session-A",
        kind: "mcp",
        serverName: "playwright",
        toolName: "browser_click",
        toolTitle: undefined,
        toolDescription: undefined,
        toolArgs: {},
        readOnly: false,
        toolCallId: undefined,
      } satisfies ApprovalRequest,
      true,
    ],
    [
      "Playwright hyphen-prefixed tool",
      {
        id: "req-playwright-hyphen",
        sessionId: "session-A",
        kind: "mcp",
        serverName: undefined,
        toolName: "playwright-browser_navigate",
        toolTitle: undefined,
        toolDescription: undefined,
        toolArgs: {},
        readOnly: false,
        toolCallId: undefined,
      } satisfies ApprovalRequest,
      true,
    ],
    [
      "Playwright double-underscore-prefixed tool",
      {
        id: "req-playwright-double-underscore",
        sessionId: "session-A",
        kind: "mcp",
        serverName: undefined,
        toolName: "playwright__browser_navigate",
        toolTitle: undefined,
        toolDescription: undefined,
        toolArgs: {},
        readOnly: false,
        toolCallId: undefined,
      } satisfies ApprovalRequest,
      true,
    ],
    [
      "custom server browser-named tool",
      {
        id: "req-custom-browser-history",
        sessionId: "session-A",
        kind: "mcp",
        serverName: "custom",
        toolName: "browser_history",
        toolTitle: undefined,
        toolDescription: undefined,
        toolArgs: {},
        readOnly: false,
        toolCallId: undefined,
      } satisfies ApprovalRequest,
      false,
    ],
    [
      "details.name fallback",
      {
        id: "req-details-name",
        sessionId: "session-A",
        kind: "mcp",
        serverName: undefined,
        toolName: "browser_click",
        toolTitle: undefined,
        toolDescription: undefined,
        toolArgs: {},
        readOnly: false,
        toolCallId: undefined,
      } satisfies ApprovalRequest,
      false,
    ],
  ])("sets browser-use disclosure for %s", async (_name, permissionRequest, expected) => {
    const broker = new ApprovalBroker();
    manager.connectBroker(broker);

    void broker.requestPrompt({
      requestId: permissionRequest.id,
      sessionId: "session-A",
      permissionRequest,
    });
    await flush();

    const card = manager.getCards("session-A")[0];
    expect(card.browserUseDisclosure).toBe(expected);
  });

  // ── respondCard ────────────────────────────────────────────────────────

  it("respondCard sets resolved to allowed", async () => {
    manager.addCard(makePrompt("p1"));
    manager.respondCard("p1", "allow");
    expect(manager.getCards("session-A")[0].resolved).toBe("allowed");
  });

  it("respondCard sets resolved to denied for deny action", async () => {
    manager.addCard(makePrompt("p1"));
    manager.respondCard("p1", "deny");
    expect(manager.getCards("session-A")[0].resolved).toBe("denied");
  });

  it("respondCard sets resolved to allowed for allow-type", async () => {
    manager.addCard(makePrompt("p1"));
    manager.respondCard("p1", "allow-type");
    expect(manager.getCards("session-A")[0].resolved).toBe("allowed");
  });

  it("respondCard sets resolved to allowed for allow-all", async () => {
    manager.addCard(makePrompt("p1"));
    manager.respondCard("p1", "allow-all");
    expect(manager.getCards("session-A")[0].resolved).toBe("allowed");
  });

  it("respondCard is a no-op for unknown requestId", async () => {
    manager.addCard(makePrompt("p1"));
    manager.respondCard("nonexistent", "allow");
    expect(manager.getCards("session-A")[0].resolved).toBeUndefined();
  });

  // ── respondFailed ──────────────────────────────────────────────────────

  it("respondFailed sets resolved to denied on unresolved card", async () => {
    manager.addCard(makePrompt("p1"));
    manager.respondFailed("p1");
    expect(manager.getCards("session-A")[0].resolved).toBe("denied");
  });

  it("respondFailed does not overwrite already-resolved card", async () => {
    manager.addCard(makePrompt("p1"));
    manager.respondCard("p1", "allow");
    manager.respondFailed("p1");
    // Guard prevents overwrite — card stays "allowed"
    expect(manager.getCards("session-A")[0].resolved).toBe("allowed");
  });

  // ── timeoutCard ────────────────────────────────────────────────────────

  it("timeoutCard sets resolved to timed-out for unresolved card", async () => {
    manager.addCard(makePrompt("p1"));
    manager.timeoutCard("p1");
    expect(manager.getCards("session-A")[0].resolved).toBe("timed-out");
  });

  it("timeoutCard does not affect already-resolved card", async () => {
    manager.addCard(makePrompt("p1"));
    manager.respondCard("p1", "allow");
    manager.timeoutCard("p1");
    expect(manager.getCards("session-A")[0].resolved).toBe("allowed");
  });

  // ── updateClassification ───────────────────────────────────────────────

  it("updateClassification patches pending card with category + suggestedPattern", () => {
    manager.addCard(makePrompt("p1"));
    manager.updateClassification("p1", {
      explanation: "",
      category: "writes",
      suggestedPattern: "npm install *",
      patternRationale: "install cmd",
      source: "llm",
      guardrailRuleId: null,
    });
    const card = manager.getCards("session-A")[0];
    expect(card.category).toBe("writes");
    expect(card.suggestedPattern).toBe("npm install *");
    expect(card.patternRationale).toBe("install cmd");
  });

  it("updateClassification pushes the updated card to the renderer", () => {
    manager.addCard(makePrompt("p1"));
    mockWindow.webContents.send.mockClear();
    manager.updateClassification("p1", {
      explanation: "",
      category: "writes",
      suggestedPattern: "npm install *",
      patternRationale: null,
      source: "llm",
      guardrailRuleId: null,
    });
    expect(mockWindow.webContents.send).toHaveBeenCalledWith(
      "permissions:cards-changed",
      expect.objectContaining({ sessionId: "session-A" }),
    );
  });

  it("updateClassification is a no-op when the card is missing", () => {
    mockWindow.webContents.send.mockClear();
    manager.updateClassification("unknown", {
      explanation: "",
      category: "writes",
      suggestedPattern: "npm install *",
      patternRationale: null,
      source: "llm",
      guardrailRuleId: null,
    });
    expect(mockWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("updateClassification is a no-op when classifier returned nothing useful (unknown + null)", () => {
    manager.addCard(makePrompt("p1"));
    mockWindow.webContents.send.mockClear();
    manager.updateClassification("p1", {
      explanation: "",
      category: "unknown",
      suggestedPattern: null,
      patternRationale: null,
      source: "fallback",
      guardrailRuleId: null,
    });
    const card = manager.getCards("session-A")[0];
    expect(card.category).toBeUndefined();
    expect(card.suggestedPattern).toBeUndefined();
    expect(card.patternRationale).toBeUndefined();
    // No renderer push either — truly no-op.
    expect(mockWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("updateClassification is a no-op when the card is already resolved", () => {
    manager.addCard(makePrompt("p1"));
    manager.respondCard("p1", "allow");
    manager.updateClassification("p1", {
      explanation: "",
      category: "writes",
      suggestedPattern: "npm install *",
      patternRationale: null,
      source: "llm",
      guardrailRuleId: null,
    });
    const card = manager.getCards("session-A")[0];
    // Classification fields MUST NOT mutate after the user has resolved the card.
    expect(card.suggestedPattern).toBeUndefined();
    expect(card.category).toBeUndefined();
  });

  it("updateClassification is idempotent across repeated calls with the same payload", () => {
    manager.addCard(makePrompt("p1"));
    const payload = {
      explanation: "",
      category: "writes" as const,
      suggestedPattern: "npm install *",
      patternRationale: "install cmd",
      source: "llm" as const,
      guardrailRuleId: null,
    };
    manager.updateClassification("p1", payload);
    manager.updateClassification("p1", payload);
    manager.updateClassification("p1", payload);
    const card = manager.getCards("session-A")[0];
    expect(card.category).toBe("writes");
    expect(card.suggestedPattern).toBe("npm install *");
    expect(card.patternRationale).toBe("install cmd");
  });

  it("updateClassification merges partial later payloads without clobbering earlier ones", () => {
    manager.addCard(makePrompt("p1"));
    manager.updateClassification("p1", {
      explanation: "",
      category: "writes",
      suggestedPattern: "npm install *",
      patternRationale: "install cmd",
      source: "llm",
      guardrailRuleId: null,
    });
    // Later call with no suggestedPattern / rationale — must keep prior values.
    // (Broker emits once in practice, but protecting against races.)
    manager.updateClassification("p1", {
      explanation: "",
      category: "destructive",
      suggestedPattern: null,
      patternRationale: null,
      source: "llm",
      guardrailRuleId: null,
    });
    const card = manager.getCards("session-A")[0];
    expect(card.category).toBe("destructive");
    expect(card.suggestedPattern).toBe("npm install *");
    expect(card.patternRationale).toBe("install cmd");
  });

  it("updateClassification does not touch the primary-button semantics", () => {
    manager.addCard(makePrompt("p1", { primaryPattern: "echo *" }));
    const before = manager.getCards("session-A")[0];
    const beforeButtons = before.buttons;
    const beforePrimary = before.primaryPattern;
    manager.updateClassification("p1", {
      explanation: "explanation text",
      category: "writes",
      suggestedPattern: "npm install *",
      patternRationale: null,
      source: "llm",
      guardrailRuleId: null,
    });
    const after = manager.getCards("session-A")[0];
    // The primary's stored pattern and button layout must not shift.
    expect(after.primaryPattern).toBe(beforePrimary);
    expect(after.buttons).toBe(beforeButtons);
  });

  it("updateClassification upgrades the card message when card is showing the SDK-generic fallback", () => {
    manager.addCard(makePrompt("p1", { message: "Marshal wants to run a terminal command" }));
    manager.updateClassification("p1", {
      explanation: "Installs an npm dependency.",
      category: "writes",
      suggestedPattern: "npm install *",
      patternRationale: null,
      source: "llm",
      guardrailRuleId: null,
    });
    expect(manager.getCards("session-A")[0].message).toBe("Installs an npm dependency.");
  });

  it("updateClassification does NOT overwrite an SDK-supplied friendly message", () => {
    manager.addCard(makePrompt("p1", { message: "Extract key PR details" }));
    manager.updateClassification("p1", {
      explanation: "Runs an arbitrary shell command.",
      category: "unknown",
      suggestedPattern: "gh pr view *",
      patternRationale: null,
      source: "llm",
      guardrailRuleId: null,
    });
    // SDK's friendly description takes precedence over the classifier's.
    expect(manager.getCards("session-A")[0].message).toBe("Extract key PR details");
  });

  // ── resolve (unified Promise + card state) ──────────────────────────────

  it("resolve returns {success: false} and calls respondFailed when no pending Promise", async () => {
    manager.addCard(makePrompt("p1"));
    // No pending promise → resolve falls through to respondFailed
    const result = manager.resolve("p1", "allow");
    expect(result.success).toBe(false);
    expect(manager.getCards("session-A")[0].resolved).toBe("denied");
  });

  it("hasPending returns false for unknown requestId", async () => {
    expect(manager.hasPending("nonexistent")).toBe(false);
  });

  // ── toolComplete ───────────────────────────────────────────────────────

  it("toolComplete sets output and resolved for allowed card", async () => {
    manager.addCard(makePrompt("p1"));
    manager.respondCard("p1", "allow");
    manager.toolComplete("tc-p1", "command output", true);

    const card = manager.getCards("session-A")[0];
    expect(card.output).toBe("command output");
    expect(card.resolved).toBe("allowed");
  });

  it("toolComplete marks as failed when success is false", async () => {
    manager.addCard(makePrompt("p1"));
    manager.respondCard("p1", "allow");
    manager.toolComplete("tc-p1", "error msg", false);

    const card = manager.getCards("session-A")[0];
    expect(card.output).toBe("error msg");
    expect(card.resolved).toBe("failed");
  });

  it("toolComplete does not affect cards that already have output", async () => {
    manager.addCard(makePrompt("p1"));
    manager.respondCard("p1", "allow");
    manager.toolComplete("tc-p1", "first", true);
    manager.toolComplete("tc-p1", "second", false);

    const card = manager.getCards("session-A")[0];
    expect(card.output).toBe("first");
    expect(card.resolved).toBe("allowed");
  });

  it("toolComplete does not affect pending (unresolved) cards", async () => {
    manager.addCard(makePrompt("p1"));
    manager.toolComplete("tc-p1", "output", true);

    const card = manager.getCards("session-A")[0];
    expect(card.output).toBeUndefined();
  });

  it("toolComplete does not affect denied cards", async () => {
    manager.addCard(makePrompt("p1"));
    manager.respondCard("p1", "deny");
    manager.toolComplete("tc-p1", "output", true);

    const card = manager.getCards("session-A")[0];
    expect(card.output).toBeUndefined();
  });

  // ── resolveStuck ───────────────────────────────────────────────────────

  it("resolveStuck marks all running cards in session as completed", async () => {
    manager.addCard(makePrompt("p1"));
    manager.addCard(makePrompt("p2", { sessionId: "session-A", toolCallId: "tc-p2" }));
    manager.respondCard("p1", "allow");
    manager.respondCard("p2", "allow");
    manager.resolveStuck("session-A");

    const cards = manager.getCards("session-A");
    expect(cards[0].output).toBe("");
    expect(cards[1].output).toBe("");
  });

  it("resolveStuck does not affect other sessions", async () => {
    manager.addCard(makePrompt("p1", { sessionId: "session-A" }));
    manager.addCard(makePrompt("p2", { sessionId: "session-B" }));
    manager.respondCard("p1", "allow");
    manager.respondCard("p2", "allow");
    manager.resolveStuck("session-A");

    expect(manager.getCards("session-A")[0].output).toBe("");
    expect(manager.getCards("session-B")[0].output).toBeUndefined();
  });

  it("resolveStuck resolves routed subagent cards stored on the parent session", async () => {
    mockSessionManager.getPermissionPromptSessionId.mockImplementation((id) =>
      id === "child-session" ? "parent-session" : id,
    );
    manager.addCard(makePrompt("p1", { sessionId: "parent-session" }));
    manager.respondCard("p1", "allow");

    manager.resolveStuck("child-session");

    expect(manager.getCards("parent-session")[0].output).toBe("");
  });

  it("resolveStuck is a no-op when no stuck cards exist", async () => {
    manager.addCard(makePrompt("p1"));
    mockWindow.webContents.send.mockClear();
    mockSessionManager.savePermissionCards.mockClear();

    manager.resolveStuck("session-A");
    // Pending card (not resolved) is not "stuck" — it's just pending
    expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    expect(mockSessionManager.savePermissionCards).not.toHaveBeenCalled();
  });

  // ── loadFromDisk ───────────────────────────────────────────────────────

  it("loadFromDisk merges disk cards with in-memory cards", async () => {
    manager.addCard(makePrompt("inmem", { sessionId: "session-A" }));
    mockSessionManager.getSession.mockReturnValueOnce({
      permissionCards: [
        makeCard("disk1", { resolved: "allowed", output: "ok", sessionId: "session-A" }),
      ],
    });

    manager.loadFromDisk("session-A");
    const cards = manager.getCards("session-A");
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.id).sort()).toEqual(["disk1", "inmem"]);
  });

  it("loadFromDisk detects stale running cards and marks them completed", async () => {
    mockSessionManager.getSession.mockReturnValueOnce({
      permissionCards: [makeCard("stale", { resolved: "allowed", sessionId: "session-A" })],
    });

    manager.loadFromDisk("session-A");
    expect(manager.getCards("session-A")[0].output).toBe("");
  });

  it("loadFromDisk keeps pending cards pending", async () => {
    // Restored pending cards have no live broker entry (in-memory only) and
    // the SDK turn that was waiting on them is gone. We leave them pending
    // anyway — clicking Allow later flows through broker.resolve → returns
    // false → respondFailed marks them "failed". See loadFromDisk comment.
    mockSessionManager.getSession.mockReturnValueOnce({
      permissionCards: [makeCard("pending", { sessionId: "session-A" })],
    });

    manager.loadFromDisk("session-A");
    expect(manager.getCards("session-A")[0].resolved).toBeUndefined();
  });

  it("loadFromDisk preserves already-complete cards", async () => {
    mockSessionManager.getSession.mockReturnValueOnce({
      permissionCards: [
        makeCard("done", { resolved: "allowed", output: "result", sessionId: "session-A" }),
      ],
    });

    manager.loadFromDisk("session-A");
    const card = manager.getCards("session-A")[0];
    expect(card.output).toBe("result");
    expect(card.resolved).toBe("allowed");
  });

  it("loadFromDisk deduplicates by id", async () => {
    manager.addCard(makePrompt("p1", { sessionId: "session-A" }));
    mockSessionManager.getSession.mockReturnValueOnce({
      permissionCards: [makeCard("p1", { sessionId: "session-A" })],
    });

    manager.loadFromDisk("session-A");
    expect(manager.getCards("session-A")).toHaveLength(1);
  });

  // ── clearSession ───────────────────────────────────────────────────────

  it("clearSession empties in-memory cards", async () => {
    manager.addCard(makePrompt("p1"));
    manager.clearSession("session-A");
    expect(manager.getCards("session-A")).toEqual([]);
  });

  it("clearSession pushes empty array to renderer", async () => {
    manager.addCard(makePrompt("p1"));
    mockWindow.webContents.send.mockClear();
    manager.clearSession("session-A");
    expect(mockWindow.webContents.send).toHaveBeenCalledWith("permissions:cards-changed", {
      sessionId: "session-A",
      cards: [],
    });
  });

  it("clearSession does not persist to disk", async () => {
    manager.addCard(makePrompt("p1"));
    mockSessionManager.savePermissionCards.mockClear();
    manager.clearSession("session-A");
    expect(mockSessionManager.savePermissionCards).not.toHaveBeenCalled();
  });

  // ── getCards ────────────────────────────────────────────────────────────

  it("getCards returns empty array for unknown session", async () => {
    expect(manager.getCards("nonexistent")).toEqual([]);
  });

  // ── SDK event subscription ─────────────────────────────────────────────

  describe("TurnEvent subscription", () => {
    let turnEventListener: (sid: string, event: unknown) => void;

    beforeEach(() => {
      mockSessionManager.addEventListener.mockImplementation(
        (listener: (sid: string, event: unknown) => void) => {
          turnEventListener = listener;
          return () => {};
        },
      );
      manager.start();
    });

    it("turn:tool-completed resolves card with output", async () => {
      manager.addCard(makePrompt("p1"));
      manager.respondCard("p1", "allow");

      turnEventListener("session-A", {
        type: "turn:tool-completed",
        toolCallId: "tc-p1",
        output: "command output",
        success: true,
      });

      const card = manager.getCards("session-A")[0];
      expect(card.output).toBe("command output");
      expect(card.resolved).toBe("allowed");
    });

    it("turn:tool-completed marks as failed when success is false", async () => {
      manager.addCard(makePrompt("p1"));
      manager.respondCard("p1", "allow");

      turnEventListener("session-A", {
        type: "turn:tool-completed",
        toolCallId: "tc-p1",
        output: "error msg",
        success: false,
      });

      const card = manager.getCards("session-A")[0];
      expect(card.output).toBe("error msg");
      expect(card.resolved).toBe("failed");
    });

    it("turn:tool-completed with empty output (tool.execution_end equivalent)", async () => {
      manager.addCard(makePrompt("p1"));
      manager.respondCard("p1", "allow");

      turnEventListener("session-A", {
        type: "turn:tool-completed",
        toolCallId: "tc-p1",
        output: "",
        success: true,
      });

      const card = manager.getCards("session-A")[0];
      expect(card.output).toBe("");
      expect(card.resolved).toBe("allowed");
    });

    it("turn:error resolves stuck cards", async () => {
      manager.addCard(makePrompt("p1"));
      manager.respondCard("p1", "allow");

      turnEventListener("session-A", { type: "turn:error", error: "fail" });

      expect(manager.getCards("session-A")[0].output).toBe("");
    });

    it("turn:idle resolves stuck cards", async () => {
      manager.addCard(makePrompt("p1"));
      manager.respondCard("p1", "allow");

      turnEventListener("session-A", { type: "turn:idle" });

      expect(manager.getCards("session-A")[0].output).toBe("");
    });

    it("TurnEvents ignore cards without matching toolCallId", async () => {
      manager.addCard(makePrompt("p1"));
      manager.respondCard("p1", "allow");

      turnEventListener("session-A", {
        type: "turn:tool-completed",
        toolCallId: "unknown-tc",
        output: "output",
        success: true,
      });

      expect(manager.getCards("session-A")[0].output).toBeUndefined();
    });
  });

  // ── Cross-session isolation ────────────────────────────────────────────

  describe("cross-session", () => {
    it("toolComplete resolves card in correct session by toolCallId", async () => {
      manager.addCard(makePrompt("p1", { sessionId: "session-A", toolCallId: "tc1" }));
      manager.addCard(makePrompt("p2", { sessionId: "session-B", toolCallId: "tc2" }));
      manager.respondCard("p1", "allow");
      manager.respondCard("p2", "allow");

      manager.toolComplete("tc1", "output-A", true);

      expect(manager.getCards("session-A")[0].output).toBe("output-A");
      expect(manager.getCards("session-B")[0].output).toBeUndefined();
    });

    it("respondCard finds card across sessions", async () => {
      manager.addCard(makePrompt("p1", { sessionId: "session-A" }));
      manager.addCard(makePrompt("p2", { sessionId: "session-B" }));

      manager.respondCard("p2", "allow");

      expect(manager.getCards("session-A")[0].resolved).toBeUndefined();
      expect(manager.getCards("session-B")[0].resolved).toBe("allowed");
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("pushToRenderer is a no-op when window is null", async () => {
      const { manager: mgr } = (() => {
        const mockSessionManager2 = {
          addEventListener: vi.fn<() => () => void>(() => () => {}),
          savePermissionCards: vi.fn<(id: string, cards: PermissionCardData[]) => void>(),
          getSession: vi.fn<() => null>(() => null),
        };
        return {
          manager: new PermissionCardManager({
            getWindow: () => null,
            sessionManager: testDouble<SessionManager>(mockSessionManager2),
          }),
        };
      })();

      // Should not throw
      mgr.addCard(makePrompt("p1"));
      expect(mgr.getCards("session-A")).toHaveLength(1);
    });

    it("pushToRenderer is a no-op when window is destroyed", async () => {
      mockWindow.isDestroyed.mockReturnValue(true);
      manager.addCard(makePrompt("p1"));
      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });

    it("persistToDisk is a no-op for empty sessionId", async () => {
      manager.addCard(makePrompt("p1", { sessionId: "" }));
      expect(mockSessionManager.savePermissionCards).not.toHaveBeenCalled();
    });

    it("respond then immediate toolComplete both succeed (race scenario)", async () => {
      manager.addCard(makePrompt("p1"));
      manager.respondCard("p1", "allow");
      manager.toolComplete("tc-p1", "done", true);

      const card = manager.getCards("session-A")[0];
      expect(card.resolved).toBe("allowed");
      expect(card.output).toBe("done");
    });

    it("timeout then resolve: resolve returns false and card stays timed-out", async () => {
      manager.addCard(makePrompt("p1"));
      manager.timeoutCard("p1");

      // resolve() finds no pending → calls respondFailed.
      // respondFailed now guards against overwriting terminal states.
      const result = manager.resolve("p1", "allow");
      expect(result.success).toBe(false);
      expect(manager.getCards("session-A")[0].resolved).toBe("timed-out");
    });

    it("dispose unsubscribes from SDK events", async () => {
      const unsubFn = vi.fn<() => void>();
      mockSessionManager.addEventListener.mockReturnValueOnce(unsubFn);
      manager.start();
      manager.dispose();
      expect(unsubFn).toHaveBeenCalled();
    });
  });

  // ── Regression: background permissions survive without renderer ──

  describe("background permissions regression", () => {
    it("card created + resolved without any renderer interaction", async () => {
      // Simulates a background session where ChatPanel is unmounted.
      // The manager creates the card, persists it, and resolves it
      // entirely in the main process — no renderer needed.
      manager.addCard(makePrompt("bg-1", { sessionId: "bg-session" }));

      // Card exists and was persisted
      expect(manager.getCards("bg-session")).toHaveLength(1);
      expect(mockSessionManager.savePermissionCards).toHaveBeenCalledWith(
        "bg-session",
        expect.arrayContaining([expect.objectContaining({ id: "bg-1" })]),
      );

      // Simulate user responding later (e.g., after switching to the session)
      manager.respondCard("bg-1", "allow");
      expect(manager.getCards("bg-session")[0].resolved).toBe("allowed");

      // Simulate tool completion via SDK event
      manager.toolComplete("tc-bg-1", "background output", true);
      expect(manager.getCards("bg-session")[0].output).toBe("background output");

      // All state changes persisted without renderer involvement
      expect(mockSessionManager.savePermissionCards).toHaveBeenCalledTimes(3);
    });

    it("card times out without renderer and state is persisted", async () => {
      manager.addCard(makePrompt("bg-2", { sessionId: "bg-session" }));
      manager.timeoutCard("bg-2");

      expect(manager.getCards("bg-session")[0].resolved).toBe("timed-out");
      expect(mockSessionManager.savePermissionCards).toHaveBeenCalledWith(
        "bg-session",
        expect.arrayContaining([expect.objectContaining({ id: "bg-2", resolved: "timed-out" })]),
      );
    });
  });

  // ── connectBroker (broker event subscription) ────────────────────────────

  describe("connectBroker", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function makeBrokerRequest(
      requestId: string,
      overrides: Omit<Partial<BrokerRequest>, "permissionRequest"> & {
        permissionRequest?: ApprovalRequest;
      } = {},
    ): BrokerRequest {
      const defaultPermissionRequest: ApprovalRequest = {
        id: requestId,
        sessionId: "s1",
        kind: "shell",
        toolCallId: `tc-${requestId}`,
        command: `echo ${requestId}`,
        serverName: "",
        intention: undefined,
        warning: undefined,
        commandIdentifiers: [],
      };
      return {
        permissionRequest: overrides.permissionRequest ?? defaultPermissionRequest,
        requestId,
        sessionId: "s1",
        ...overrides,
      };
    }

    function createBrokerManager() {
      const broker = new ApprovalBroker(100); // short timeout for tests
      const mockWin = {
        isDestroyed: vi.fn<() => boolean>().mockReturnValue(false),
        webContents: { send: vi.fn<(channel: string, ...args: unknown[]) => void>() },
        flashFrame: vi.fn<() => void>(),
      };
      const mockSM = {
        addEventListener: vi.fn<() => () => void>(() => () => {}),
        savePermissionCards: vi.fn<(id: string, cards: PermissionCardData[]) => void>(),
        getSession: vi.fn<() => null>(() => null),
        getPermissionPromptSessionId: vi.fn<(id: string) => string>((id) => id),
        getWorkspaceRootForSession: vi.fn<(id?: string) => string | undefined>(() => undefined),
      };
      const mgr = new PermissionCardManager({
        getWindow: () => testDouble<import("electron").BrowserWindow>(mockWin),
        sessionManager: testDouble<SessionManager>(mockSM),
      });
      mgr.connectBroker(broker);
      return { mgr, broker, mockWin, mockSM };
    }

    it("onPending creates a card with formatted dialog data", async () => {
      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();

      const cards = mgr.getCards("s1");
      expect(cards).toHaveLength(1);
      expect(cards[0].id).toBe("p1");
      // Title comes from formatPermissionDialog (mocked), not from BrokerRequest
      expect(cards[0].title).toBe("Test Title");
      expect(cards[0].message).toBe("Test message");
      expect(cards[0].buttons).toEqual(["Allow", "Allow for session", "Always allow", "Deny"]);
      expect(cards[0].tooltips).toBeUndefined();
      broker.resolve("p1", "allow");
    });

    it("formats parent-routed subagent cards with the originating session workspace", async () => {
      const { mgr, broker, mockSM } = createBrokerManager();
      mockSM.getPermissionPromptSessionId.mockImplementation((id) =>
        id === "child-session" ? "parent-session" : id,
      );
      mockSM.getWorkspaceRootForSession.mockImplementation((id) =>
        id === "child-session" ? "C:\\worktrees\\child" : undefined,
      );

      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "child-session",
            kind: "write",
            path: "C:\\worktrees\\child\\electron\\file.ts",
            diff: null,
            intention: undefined,
            origin: "sdk",
            browserToolName: undefined,
            toolCallId: "tc-p1",
          },
          sessionId: "child-session",
        }),
      );
      await flush();

      expect(formatPermissionDialog).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "child-session" }),
        "C:\\worktrees\\child",
      );
      expect(mgr.getCards("parent-session")).toHaveLength(1);
      broker.resolve("p1", "allow");
    });

    it("onPending stores subagent permission cards on the parent session", async () => {
      const { mgr, broker, mockSM } = createBrokerManager();
      mockSM.getPermissionPromptSessionId.mockImplementation((id) =>
        id === "child-session" ? "parent-session" : id,
      );
      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "child-session",
            kind: "shell",
            toolCallId: "tc-p1",
            command: "npm test",
            serverName: "",
            intention: undefined,
            warning: undefined,
            commandIdentifiers: [],
          },
          sessionId: "child-session",
        }),
      );
      await flush();

      expect(mgr.getCards("child-session")).toHaveLength(0);
      expect(mgr.getCards("parent-session")).toHaveLength(1);
      expect(mockSM.savePermissionCards).toHaveBeenCalledWith(
        "parent-session",
        expect.arrayContaining([expect.objectContaining({ id: "p1" })]),
      );
      broker.resolve("p1", "allow");
    });

    it("threads SDK prompt metadata into the card and hides session approval when unavailable", async () => {
      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "s1",
            kind: "shell",
            toolCallId: "tc-p1",
            command: "git status",
            intention: "Check repository status",
            warning: "This command touches the working tree metadata.",
            commandIdentifiers: ["git"],
            serverName: "",
          },
        }),
      );
      await flush();

      const cards = mgr.getCards("s1");
      expect(cards[0].message).toBe("Check repository status");
      expect(cards[0].sdkIntention).toBe("Check repository status");
      expect(cards[0].detail).toContain("Warning: This command touches the working tree metadata.");
      expect(cards[0].sdkWarning).toBe("This command touches the working tree metadata.");
      expect(cards[0].sdkCommandIdentifiers).toEqual(["git"]);
      expect(cards[0].buttons).toEqual(["Allow", "Allow for session", "Always allow", "Deny"]);
      broker.resolve("p1", "allow");
    });

    it("offers 'Allow for session' for hook permissions (Marshal-side scoped approval works for hooks)", async () => {
      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "s1",
            kind: "hook",
            toolCallId: "tc-p1",
            toolName: "session-hook",
            toolArgs: {},
          },
        }),
      );
      await flush();

      const cards = mgr.getCards("s1");
      expect(cards[0].buttons).toEqual(["Allow", "Allow for session", "Always allow", "Deny"]);
      broker.resolve("p1", "allow");
    });

    it("onPending flashes window frame", async () => {
      const { broker, mockWin } = createBrokerManager();
      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();
      expect(mockWin.flashFrame).toHaveBeenCalledWith(true);
      broker.resolve("p1", "allow");
    });

    it("onPending fires onApprovalRequested callback", async () => {
      const { mgr, broker } = createBrokerManager();
      const onRequested = vi.fn<() => void>();
      mgr.setCallbacks({ onApprovalRequested: onRequested });

      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();
      expect(onRequested).toHaveBeenCalledOnce();
      broker.resolve("p1", "allow");
    });

    it("onPending fires onPrompt callback with formatted dialog data", async () => {
      const { mgr, broker } = createBrokerManager();
      const onPrompt =
        vi.fn<
          (
            t: string,
            m: string,
            d: string,
            rid: string,
            sid?: string,
            tt?: Record<string, string>,
            buttons?: string[],
          ) => void
        >();
      mgr.setCallbacks({ onPrompt });

      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "s-test",
            kind: "write",
            path: "",
            diff: null,
            intention: undefined,
            origin: "sdk",
            browserToolName: undefined,
            toolCallId: undefined,
          },
          sessionId: "s-test",
        }),
      );
      await flush();

      expect(onPrompt).toHaveBeenCalledOnce();
      const [title, message, detail, requestId, sessionId, tooltips, buttons] =
        onPrompt.mock.calls[0];
      // Values come from formatPermissionDialog (mocked); tooltips are owned
      // by the renderer now and intentionally undefined from the main process.
      expect(title).toBe("Test Title");
      expect(message).toBe("Test message");
      expect(detail).toBe("test detail");
      expect(requestId).toBe("p1");
      expect(sessionId).toBe("s-test");
      expect(tooltips).toBeUndefined();
      expect(buttons).toEqual(["Allow", "Allow for session", "Always allow", "Deny"]);
      broker.resolve("p1", "allow");
    });

    it("onPending renders browser code-execution write card with tool-specific message", async () => {
      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "s1",
            kind: "write",
            toolCallId: "tc-p1",
            path: "*",
            origin: "synthesized-browser",
            browserToolName: "browser_run_code",
            diff: null,
            intention: undefined,
          },
          sessionId: "s1",
        }),
      );
      await flush();

      const cards = mgr.getCards("s1");
      expect(cards).toHaveLength(1);
      expect(cards[0].title).toBe("Browser code execution");
      expect(cards[0].message).toBe("browser_run_code may write files to disk");
      expect(cards[0].category).toBe("writes");
      broker.resolve("p1", "allow");
    });

    it("onPending renders browser write card with fallback name when toolName is absent", async () => {
      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "s1",
            kind: "write",
            toolCallId: "tc-p1",
            path: "*",
            origin: "synthesized-browser",
            diff: null,
            intention: undefined,
            browserToolName: undefined,
          },
          sessionId: "s1",
        }),
      );
      await flush();

      const cards = mgr.getCards("s1");
      expect(cards).toHaveLength(1);
      expect(cards[0].title).toBe("Browser code execution");
      expect(cards[0].message).toBe("browser code execution may write files to disk");
      expect(cards[0].category).toBe("writes");
      broker.resolve("p1", "allow");
    });

    it("onPending uses normal write rendering when isBrowserWrite is true but path is not *", async () => {
      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "s1",
            kind: "write",
            toolCallId: "tc-p1",
            path: "/tmp/screenshot.png",
            origin: "synthesized-browser",
            browserToolName: "browser_take_screenshot",
            diff: null,
            intention: undefined,
          },
          sessionId: "s1",
        }),
      );
      await flush();

      const cards = mgr.getCards("s1");
      expect(cards).toHaveLength(1);
      // Falls through to normal write rendering — mocked formatPermissionDialog returns "Test Title"
      expect(cards[0].title).toBe("Test Title");
      broker.resolve("p1", "allow");
    });

    it("redacts the forget-completely memory from onPrompt (relay) but keeps it on the in-app card", async () => {
      const { mgr, broker } = createBrokerManager();
      const onPrompt =
        vi.fn<
          (
            t: string,
            m: string,
            d: string,
            rid: string,
            sid?: string,
            tips?: Record<string, string>,
            buttons?: string[],
          ) => void
        >();
      mgr.setCallbacks({ onPrompt });

      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "s1",
            kind: "settings",
            toolCallId: undefined,
            diff: { forgetCompletely: { memoryText: "private memory" } },
          },
        }),
      );
      await flush();

      expect(onPrompt).toHaveBeenCalledOnce();
      const [, promptMessage, promptDetail, , , , promptButtons] = onPrompt.mock.calls[0];
      expect(promptMessage).toBe(
        "Marshal wants to erase a memory permanently. Review it in Marshal.",
      );
      expect(promptDetail).toBe("");
      expect(promptButtons).toEqual(["Open in Marshal", "Deny"]);
      const cards = mgr.getCards("s1");
      expect(cards[0].message).toBe("Test message");
      expect(cards[0].detail).toBe("test detail");

      broker.resolve("p1", "deny");
    });

    it("does not redact non-calendar custom tool notifications", async () => {
      const { mgr, broker } = createBrokerManager();
      const onPrompt =
        vi.fn<(t: string, m: string, d: string, rid: string, sid?: string) => void>();
      mgr.setCallbacks({ onPrompt });

      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "s1",
            kind: "custom-tool",
            toolCallId: "tc-p1",
            toolName: "sendEmail",
            toolArgs: { to: "alice@co.com" },
            toolDescription: undefined,
            intention: undefined,
            warning: undefined,
            commandIdentifiers: [],
          },
        }),
      );
      await flush();

      // Non-calendar tools should keep the full message
      const [, promptMessage] = onPrompt.mock.calls[0];
      expect(promptMessage).toBe("Test message");

      broker.resolve("p1", "allow");
    });

    it("uses Allow / Deny buttons for settings (permission-change) cards", async () => {
      const { mgr, broker } = createBrokerManager();

      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "s1",
            kind: "settings",
            toolCallId: "tc-p1",
            diff: undefined,
          },
        }),
      );
      await flush();

      const cards = mgr.getCards("s1");
      expect(cards).toHaveLength(1);
      expect(cards[0].buttons).toEqual(["Allow", "Deny"]);
      expect(cards[0].canPersistAlwaysAllow).toBe(false);

      broker.resolve("p1", "deny");
    });

    it("keeps the desktop card for forget completely even when a relay handles the session", async () => {
      const { mgr, broker } = createBrokerManager();
      const onRequested = vi.fn<(req: PendingPermissionPrompt) => void>();
      mgr.setCallbacks({ onApprovalRequested: onRequested, isRelayHandled: () => true });

      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "s1",
            kind: "settings",
            toolCallId: undefined,
            diff: { forgetCompletely: { memoryText: "private memory" } },
          },
        }),
      );
      await flush();

      expect(mgr.getCards("s1")).toHaveLength(1);
      expect(onRequested).toHaveBeenCalledWith(
        expect.objectContaining({ isForgetCompletely: true }),
      );
      broker.resolve("p1", "deny");
    });

    it("onPending skips desktop UI when isRelayHandled returns true", async () => {
      const { mgr, broker, mockWin } = createBrokerManager();
      const onRequested = vi.fn<() => void>();
      mgr.setCallbacks({ onApprovalRequested: onRequested, isRelayHandled: () => true });

      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();

      expect(onRequested).not.toHaveBeenCalled();
      expect(mgr.getCards("s1")).toHaveLength(0);
      expect(mockWin.flashFrame).not.toHaveBeenCalled();
      broker.resolve("p1", "allow");
    });

    it("onPending still fires onPrompt even when isRelayHandled returns true", async () => {
      const { mgr, broker } = createBrokerManager();
      const onPrompt = vi.fn<() => void>();
      mgr.setCallbacks({ onPrompt, isRelayHandled: () => true });

      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();
      expect(onPrompt).toHaveBeenCalledOnce();
      broker.resolve("p1", "allow");
    });

    it("card is still created when onPrompt callback throws", async () => {
      const { mgr, broker } = createBrokerManager();
      mgr.setCallbacks({
        onPrompt: () => {
          throw new Error("relay crash");
        },
      });

      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();
      // Card should still be created despite callback failure
      expect(mgr.getCards("s1")).toHaveLength(1);
      broker.resolve("p1", "allow");
    });

    it("card is still created when onApprovalRequested callback throws", async () => {
      const { mgr, broker } = createBrokerManager();
      mgr.setCallbacks({
        onApprovalRequested: () => {
          throw new Error("mini-mode crash");
        },
      });

      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();
      expect(mgr.getCards("s1")).toHaveLength(1);
      broker.resolve("p1", "allow");
    });

    it("onResolved updates card to allowed", async () => {
      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();
      broker.resolve("p1", "allow");
      expect(mgr.getCards("s1")[0].resolved).toBe("allowed");
    });

    it("onResolved updates card to denied", async () => {
      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();
      broker.resolve("p1", "deny");
      expect(mgr.getCards("s1")[0].resolved).toBe("denied");
    });

    it("onResolved fires onPermissionResolved callback", async () => {
      const { mgr, broker } = createBrokerManager();
      const onResolved = vi.fn<(id: string) => void>();
      mgr.setCallbacks({ onPermissionResolved: onResolved });

      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();
      broker.resolve("p1", "allow");
      expect(onResolved).toHaveBeenCalledWith("p1");
    });

    it("onTimeout marks card as timed-out", async () => {
      const { mgr, broker } = createBrokerManager();

      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();
      await vi.advanceTimersByTimeAsync(100);
      expect(mgr.getCards("s1")[0].resolved).toBe("timed-out");
    });

    it("onTimeout fires onPermissionResolved to clean up external state", async () => {
      const { mgr, broker } = createBrokerManager();
      const onResolved = vi.fn<(id: string) => void>();
      mgr.setCallbacks({ onPermissionResolved: onResolved });

      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();
      await vi.advanceTimersByTimeAsync(100);
      expect(onResolved).toHaveBeenCalledOnce();
      expect(onResolved).toHaveBeenCalledWith("p1");
    });

    it("timeout cleans up relay state for relay-handled sessions (integration)", async () => {
      // Integration: wire broker + card manager + simulated relay callbacks
      // to verify the full timeout → cleanup path end-to-end.
      const broker = new ApprovalBroker(100);
      const pendingPermissionIds = new Set<string>();
      const miniModeVisible = new Set<string>();
      const mockWin = {
        isDestroyed: vi.fn<() => boolean>().mockReturnValue(false),
        webContents: { send: vi.fn<() => void>() },
        flashFrame: vi.fn<() => void>(),
      };
      const mgr = new PermissionCardManager({
        getWindow: () => testDouble<import("electron").BrowserWindow>(mockWin),
        sessionManager: testDouble<SessionManager>({
          addEventListener: vi.fn<() => () => void>(() => () => {}),
          savePermissionCards: vi.fn<() => void>(),
          getSession: vi.fn<() => null>(() => null),
          getPermissionPromptSessionId: vi.fn<(id: string) => string>((id) => id),
          getWorkspaceRootForSession: vi.fn<(id?: string) => string | undefined>(() => undefined),
        }),
      });
      mgr.connectBroker(broker);

      // Wire callbacks simulating main.ts wiring with relay + mini-mode
      mgr.setCallbacks({
        onApprovalRequested: (req) => miniModeVisible.add(req.id),
        onPrompt: (_t, _m, _d, requestId) => pendingPermissionIds.add(requestId),
        onPermissionResolved: (requestId) => {
          miniModeVisible.delete(requestId);
          pendingPermissionIds.delete(requestId);
        },
        isRelayHandled: () => true, // relay session
      });

      // Simulate a permission prompt arriving via the adapter
      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();

      // Relay-handled: onPrompt fires (tracks in relay), but no card or mini-mode
      expect(pendingPermissionIds.has("p1")).toBe(true);
      expect(miniModeVisible.has("p1")).toBe(false);
      expect(mgr.getCards("s1")).toHaveLength(0);

      // Timeout fires
      await vi.advanceTimersByTimeAsync(100);

      // onPermissionResolved should have cleaned up relay state
      expect(pendingPermissionIds.has("p1")).toBe(false);
    });

    it("timeout cleans up mini-mode for desktop sessions (integration)", async () => {
      const broker = new ApprovalBroker(100);
      const miniModeVisible = new Set<string>();
      const mockWin = {
        isDestroyed: vi.fn<() => boolean>().mockReturnValue(false),
        webContents: { send: vi.fn<() => void>() },
        flashFrame: vi.fn<() => void>(),
      };
      const mgr = new PermissionCardManager({
        getWindow: () => testDouble<import("electron").BrowserWindow>(mockWin),
        sessionManager: testDouble<SessionManager>({
          addEventListener: vi.fn<() => () => void>(() => () => {}),
          savePermissionCards: vi.fn<() => void>(),
          getSession: vi.fn<() => null>(() => null),
          getPermissionPromptSessionId: vi.fn<(id: string) => string>((id) => id),
          getWorkspaceRootForSession: vi.fn<(id?: string) => string | undefined>(() => undefined),
        }),
      });
      mgr.connectBroker(broker);

      mgr.setCallbacks({
        onApprovalRequested: (req) => miniModeVisible.add(req.id),
        onPermissionResolved: (requestId) => miniModeVisible.delete(requestId),
        isRelayHandled: () => false, // desktop session
      });

      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();

      // Desktop: card + mini-mode both shown
      expect(miniModeVisible.has("p1")).toBe(true);
      expect(mgr.getCards("s1")).toHaveLength(1);

      // Timeout fires
      await vi.advanceTimersByTimeAsync(100);

      // Card shows timed-out, mini-mode dismissed
      expect(mgr.getCards("s1")[0].resolved).toBe("timed-out");
      expect(miniModeVisible.has("p1")).toBe(false);
    });

    it("resolve delegates to broker and returns success", async () => {
      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();
      const result = mgr.resolve("p1", "allow");
      expect(result.success).toBe(true);
    });

    it("resolve returns false for unknown requestId", async () => {
      const { mgr } = createBrokerManager();
      expect(mgr.resolve("unknown", "allow").success).toBe(false);
    });

    it("hasPending delegates to broker", async () => {
      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();
      expect(mgr.hasPending("p1")).toBe(true);

      broker.resolve("p1", "allow");
      expect(mgr.hasPending("p1")).toBe(false);
    });

    it("clearSession drains broker pending and clears cards", async () => {
      const { mgr, broker } = createBrokerManager();
      const p1 = broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();
      mgr.clearSession("s1");

      expect(await p1).toEqual({ outcome: "resolved", action: "deny" });
      expect(mgr.getCards("s1")).toHaveLength(0);
      expect(broker.hasPending("p1")).toBe(false);
    });

    it("dispose unsubscribes from broker events", async () => {
      const { mgr, broker } = createBrokerManager();
      mgr.dispose();

      // After dispose, broker events should not create cards
      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();
      expect(mgr.getCards("s1")).toHaveLength(0);
    });

    it("resolve returns false without broker connected", async () => {
      const { manager: mgr } = createManager();
      expect(mgr.resolve("p1", "allow").success).toBe(false);
    });

    it("hasPending returns false without broker connected", async () => {
      const { manager: mgr } = createManager();
      expect(mgr.hasPending("p1")).toBe(false);
    });

    it("skips card creation when request resolves during async formatting", async () => {
      const { mgr, broker } = createBrokerManager();

      // Start a permission request
      const requestPromise = broker.requestPrompt(makeBrokerRequest("p1"));
      // Resolve it immediately before handlePending's await completes
      broker.resolve("p1", "allow");
      await flush();
      await requestPromise.catch(() => {});

      // No card should exist — the hasPending guard prevented creation
      expect(mgr.getCards("s1")).toHaveLength(0);
    });

    it("handles concurrent permission requests in same session", async () => {
      const { mgr, broker } = createBrokerManager();

      void broker.requestPrompt(makeBrokerRequest("p1"));
      void broker.requestPrompt(makeBrokerRequest("p2"));
      await flush();

      const cards = mgr.getCards("s1");
      expect(cards).toHaveLength(2);
      expect(cards.map((c) => c.id)).toContain("p1");
      expect(cards.map((c) => c.id)).toContain("p2");

      broker.resolve("p1", "allow");
      broker.resolve("p2", "deny");
    });

    // ── resolve(overridePattern) — re-runs guardrails on the override ────

    it("resolve applies overridePattern after re-running guardrails", async () => {
      const { mgr, broker } = createBrokerManager();
      const req = makeBrokerRequest("p1", {
        permissionRequest: {
          id: "p1",
          sessionId: "s1",
          kind: "shell",
          toolCallId: "tc-p1",
          command: "npm install lodash",
          serverName: "",
          intention: undefined,
          warning: undefined,
          commandIdentifiers: [],
        } satisfies ApprovalRequest,
      });
      void broker.requestPrompt(req);
      await flush();
      // Sanity: no approvalPattern set yet (the adapter sets primary normally;
      // the broker in tests doesn't go through the adapter).
      mgr.resolve("p1", "always-allow", "npm install *");
      expect(req.permissionRequest.approvalPattern).toBe("npm install *");
    });

    it("resolve ignores overridePattern '*' that guardrails null (primary preserved)", async () => {
      const { mgr, broker } = createBrokerManager();
      const permissionRequest: ApprovalRequest = {
        id: "p1",
        sessionId: "s1",
        kind: "shell",
        toolCallId: "tc-p1",
        command: "npm install lodash",
        approvalPattern: "npm install *",
        serverName: "",
        intention: undefined,
        warning: undefined,
        commandIdentifiers: [],
      };
      void broker.requestPrompt(makeBrokerRequest("p1", { permissionRequest }));
      await flush();
      mgr.resolve("p1", "always-allow", "*");
      // Primary stays untouched; override was too broad.
      expect(permissionRequest.approvalPattern).toBe("npm install *");
    });

    it("resolve threads card.category to override guardrails (destructive blocked even if pattern looks benign)", async () => {
      const { mgr, broker } = createBrokerManager();
      // npm install is not a DENY_BINARY on its own, and "npm install *" is
      // not a DENY_PAIR, and the pattern passes G_FIRST_TOKEN_MISMATCH etc.
      // BUT the classifier marked it destructive, so G_CATEGORY_DESTRUCTIVE
      // must fire when we re-run guardrails for the override. Without the
      // category threading, the guardrail default "unknown" would let it through.
      const permissionRequest: ApprovalRequest = {
        id: "p1",
        sessionId: "s1",
        kind: "shell",
        toolCallId: "tc-p1",
        command: "npm install lodash",
        approvalPattern: "npm install lodash",
        serverName: "",
        intention: undefined,
        warning: undefined,
        commandIdentifiers: [],
      };
      void broker.requestPrompt(makeBrokerRequest("p1", { permissionRequest }));
      await flush();
      // Mark the card as destructive (as the classifier would).
      mgr.updateClassification("p1", {
        explanation: "",
        category: "destructive",
        suggestedPattern: "npm install *",
        patternRationale: "classifier disagreement",
        source: "llm",
        guardrailRuleId: null,
      });
      mgr.resolve("p1", "always-allow", "npm install *");
      // Category=destructive → G_CATEGORY_DESTRUCTIVE nulls the override;
      // primary stays.
      expect(permissionRequest.approvalPattern).toBe("npm install lodash");
    });

    it("resolve is a no-op for non-shell kinds with overridePattern", async () => {
      const { mgr, broker } = createBrokerManager();
      const permissionRequest: ApprovalRequest = {
        id: "p1",
        sessionId: "s1",
        kind: "write",
        toolCallId: "tc-p1",
        path: "src/file.ts",
        approvalPattern: undefined,
        diff: null,
        intention: undefined,
        origin: "sdk",
        browserToolName: undefined,
      };
      void broker.requestPrompt(makeBrokerRequest("p1", { permissionRequest }));
      await flush();
      mgr.resolve("p1", "always-allow", "write:*");
      expect(permissionRequest.approvalPattern).toBeUndefined();
    });

    // ── connectPolicy / defuseBurst ────────────────────────────────────

    describe("connectPolicy / defuseBurst", () => {
      type PolicyDecision = "approve" | "deny" | "prompt";

      function createFakePolicy(
        decision: PolicyDecision | ((req: ApprovalRequest) => PolicyDecision),
      ) {
        let onAlwaysAllowAdded: ((sessionId: string) => void) | null = null;
        const evaluateSilent = vi.fn<(req: ApprovalRequest) => PolicyDecision>((req) =>
          typeof decision === "function" ? decision(req) : decision,
        );
        const recordAutoResolvedSibling = vi.fn<(req: ApprovalRequest) => void>();
        const recordAutoApprovedByPolicy = vi.fn<(req: ApprovalRequest) => void>();
        const policy = {
          setOnAlwaysAllowAdded: (cb: (sessionId: string) => void) => {
            if (onAlwaysAllowAdded) throw new Error("already registered");
            onAlwaysAllowAdded = cb;
          },
          evaluateSilent,
          recordAutoResolvedSibling,
          recordAutoApprovedByPolicy,
          getSensitivePathHit: vi.fn<(req: ApprovalRequest) => null>().mockReturnValue(null),
        };
        const trigger = (sessionId: string) => {
          if (!onAlwaysAllowAdded) throw new Error("connectPolicy was not called");
          onAlwaysAllowAdded(sessionId);
        };
        return {
          policy: testDouble<import("./permission-policy").PermissionPolicy>(policy),
          trigger,
          evaluateSilent,
          recordAutoResolvedSibling,
          recordAutoApprovedByPolicy,
          isRegistered: () => onAlwaysAllowAdded !== null,
        };
      }

      it("connectPolicy registers the always-allow callback exactly once", () => {
        const { mgr } = createBrokerManager();
        const { policy, isRegistered } = createFakePolicy("approve");
        mgr.connectPolicy(policy);
        expect(isRegistered()).toBe(true);
      });

      it("auto-resolves a parallel burst of identical pending requests after always-allow", () => {
        // Models the production scenario: 18 simultaneous moveEmail
        // approvals are pending, the user clicks "always-allow" on one and
        // the policy gains a rule that matches all of them.
        const { mgr, broker } = createBrokerManager();
        const { policy, trigger } = createFakePolicy("approve");
        mgr.connectPolicy(policy);
        for (let i = 1; i <= 18; i++) {
          void broker.requestPrompt(makeBrokerRequest(`p${i}`));
        }

        trigger("s1");

        expect(broker.listPendingRequests("s1")).toHaveLength(0);
      });

      it("leaves requests pending when the policy still says prompt", () => {
        const { mgr, broker } = createBrokerManager();
        const { policy, trigger } = createFakePolicy("prompt");
        mgr.connectPolicy(policy);
        void broker.requestPrompt(makeBrokerRequest("p1"));
        void broker.requestPrompt(makeBrokerRequest("p2"));

        trigger("s1");

        expect(broker.listPendingRequests("s1")).toHaveLength(2);
      });

      it("only resolves requests whose evaluator returns approve (mixed)", () => {
        const { mgr, broker } = createBrokerManager();
        const { policy, trigger } = createFakePolicy((req) =>
          req.id === "p2" ? "approve" : "prompt",
        );
        mgr.connectPolicy(policy);
        void broker.requestPrompt(makeBrokerRequest("p1"));
        void broker.requestPrompt(makeBrokerRequest("p2"));
        void broker.requestPrompt(makeBrokerRequest("p3"));

        trigger("s1");

        const stillPending = broker.listPendingRequests("s1").map((p) => p.requestId);
        expect(stillPending.sort()).toEqual(["p1", "p3"]);
      });

      it("does not cross sessions", () => {
        // An always-allow scoped to session A must not auto-approve a
        // pending request in session B (entity-permission isolation).
        const { mgr, broker } = createBrokerManager();
        const { policy, trigger } = createFakePolicy("approve");
        mgr.connectPolicy(policy);
        void broker.requestPrompt(makeBrokerRequest("p1")); // session s1
        void broker.requestPrompt(
          makeBrokerRequest("p2", {
            sessionId: "other-session",
            permissionRequest: {
              id: "p2",
              sessionId: "other-session",
              kind: "shell",
              toolCallId: "tc-p2",
              command: "echo p2",
              serverName: "",
              intention: undefined,
              warning: undefined,
              commandIdentifiers: [],
            },
          }),
        );

        trigger("s1");

        expect(broker.listPendingRequests("other-session")).toHaveLength(1);
      });

      it("calls policy.recordAutoResolvedSibling exactly once per silently-resolved sibling", () => {
        const { mgr, broker } = createBrokerManager();
        const { policy, trigger, recordAutoResolvedSibling } = createFakePolicy("approve");
        mgr.connectPolicy(policy);
        for (let i = 1; i <= 3; i++) {
          void broker.requestPrompt(makeBrokerRequest(`p${i}`));
        }

        trigger("s1");

        expect(recordAutoResolvedSibling).toHaveBeenCalledTimes(3);
        const ids = recordAutoResolvedSibling.mock.calls.map((c) => c[0].id).sort();
        expect(ids).toEqual(["p1", "p2", "p3"]);
      });

      it("resolvePolicyApprovedPending resolves approved prompts across sessions with policy auto-approve audit", () => {
        const { mgr, broker } = createBrokerManager();
        const { policy, recordAutoApprovedByPolicy, recordAutoResolvedSibling } =
          createFakePolicy("approve");
        mgr.connectPolicy(policy);
        void broker.requestPrompt(makeBrokerRequest("p1"));
        void broker.requestPrompt(
          makeBrokerRequest("p2", {
            sessionId: "other-session",
            permissionRequest: {
              id: "p2",
              sessionId: "other-session",
              kind: "shell",
              toolCallId: "tc-p2",
              command: "echo p2",
              serverName: "",
              intention: undefined,
              warning: undefined,
              commandIdentifiers: [],
            },
          }),
        );

        const resolved = mgr.resolvePolicyApprovedPending();

        expect(resolved).toBe(2);
        expect(broker.listPendingRequests()).toHaveLength(0);
        expect(recordAutoApprovedByPolicy).toHaveBeenCalledTimes(2);
        expect(recordAutoResolvedSibling).not.toHaveBeenCalled();
      });

      it("never auto-resolves settings cards, even when policy (allow-all) approves", () => {
        const { mgr, broker } = createBrokerManager();
        const { policy } = createFakePolicy("approve");
        mgr.connectPolicy(policy);
        void broker.requestPrompt(
          makeBrokerRequest("p1", {
            permissionRequest: {
              id: "p1",
              sessionId: "s1",
              kind: "settings",
              toolCallId: undefined,
              diff: { forgetCompletely: { memoryText: "a memory" } },
            },
          }),
        );

        expect(mgr.resolvePolicyApprovedPending()).toBe(0);
        expect(broker.hasPending("p1")).toBe(true);
        broker.resolve("p1", "deny");
      });

      it("does not call policy.recordAutoResolvedSibling for siblings the policy still wants to prompt for", () => {
        const { mgr, broker } = createBrokerManager();
        const { policy, trigger, recordAutoResolvedSibling } = createFakePolicy("prompt");
        mgr.connectPolicy(policy);
        void broker.requestPrompt(makeBrokerRequest("p1"));

        trigger("s1");

        expect(recordAutoResolvedSibling).not.toHaveBeenCalled();
      });

      it("no-op when there are no pending requests", () => {
        const { mgr } = createBrokerManager();
        const { policy, trigger, evaluateSilent } = createFakePolicy("approve");
        mgr.connectPolicy(policy);

        expect(() => trigger("s1")).not.toThrow();
        expect(evaluateSilent).not.toHaveBeenCalled();
      });

      it("no-op when broker is not connected", () => {
        const mgr = new PermissionCardManager({
          getWindow: () =>
            testDouble<import("electron").BrowserWindow>({
              isDestroyed: () => false,
              webContents: { send: vi.fn<() => void>() },
            }),
          sessionManager: testDouble<SessionManager>({
            addEventListener: vi.fn<() => () => void>(() => () => {}),
            savePermissionCards: vi.fn<() => void>(),
            getSession: () => null,
          }),
        });
        const { policy, trigger, evaluateSilent } = createFakePolicy("approve");
        // No connectBroker call.
        mgr.connectPolicy(policy);
        expect(() => trigger("s1")).not.toThrow();
        expect(evaluateSilent).not.toHaveBeenCalled();
      });
    });

    // ── async enrichment (branch: calendar permission cards) ────────────

    it("shows fallback card when formatPermissionDialog rejects", async () => {
      const { formatPermissionDialog: formatPermissionDialogMock } = await import("./permissions");
      vi.mocked(formatPermissionDialogMock).mockRejectedValueOnce(new Error("Graph API down"));

      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(makeBrokerRequest("p1"));
      await flush();

      const cards = mgr.getCards("s1");
      expect(cards).toHaveLength(1);
      expect(cards[0].message).toBe("Marshal wants to perform an action");
    });

    it("does not show fallback card when request resolved before error fallback", async () => {
      const { formatPermissionDialog: formatPermissionDialogMock } = await import("./permissions");
      // A deferred rejection — handlePending awaits this, giving us time to resolve first
      let rejectFormat!: (err: Error) => void;
      vi.mocked(formatPermissionDialogMock).mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFormat = reject;
          }),
      );

      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(makeBrokerRequest("p1"));
      // Resolve before formatPermissionDialog settles
      broker.resolve("p1", "allow");
      // Now let the format rejection fire
      rejectFormat(new Error("Graph API down"));
      await flush();

      // No card should exist — the hasPending guard in the catch path prevented it
      expect(mgr.getCards("s1")).toHaveLength(0);
    });

    it("does not append 'Command identifiers:' into card.detail", async () => {
      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "s1",
            kind: "shell",
            toolCallId: "tc-p1",
            command: "rm -rf dist",
            commandIdentifiers: ["rm"],
            intention: undefined,
            warning: undefined,
            serverName: "",
          },
        }),
      );
      await flush();

      const cards = mgr.getCards("s1");
      expect(cards[0].detail).not.toContain("Command identifiers:");
      expect(cards[0].sdkCommandIdentifiers).toEqual(["rm"]);
      broker.resolve("p1", "allow");
    });

    it("canPersistAlwaysAllow=true and includes 'Always allow' for representable shell command", async () => {
      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "s1",
            kind: "shell",
            toolCallId: "tc-p1",
            command: "npm install foo",
            approvalPattern: "npm install *",
            serverName: "",
            intention: undefined,
            warning: undefined,
            commandIdentifiers: [],
          },
        }),
      );
      await flush();

      const cards = mgr.getCards("s1");
      // canPersistAlwaysAllow is the load-bearing assertion for this branch —
      // the buttons check below is incidental (pre-PR code also always
      // included "Always allow"), so a regression would only surface here.
      expect(cards[0].canPersistAlwaysAllow).toBe(true);
      expect(cards[0].buttons).toContain("Always allow");
      broker.resolve("p1", "allow");
    });

    it("canPersistAlwaysAllow=false and omits 'Always allow' when heuristic collapses to *", async () => {
      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "s1",
            kind: "shell",
            toolCallId: "tc-p1",
            command: "$env:MY_CUSTOM_RUNNER",
            serverName: "",
            intention: undefined,
            warning: undefined,
            commandIdentifiers: [],
          },
        }),
      );
      await flush();

      const cards = mgr.getCards("s1");
      expect(cards[0].canPersistAlwaysAllow).toBe(false);
      expect(cards[0].buttons).not.toContain("Always allow");
      expect(cards[0].buttons).toContain("Allow");
      expect(cards[0].buttons).toContain("Allow for session");
      expect(cards[0].buttons).toContain("Deny");
      broker.resolve("p1", "allow");
    });

    it("canPersistAlwaysAllow=false and omits 'Always allow' when guardrails refuse to generalize the command", async () => {
      const { mgr, broker } = createBrokerManager();
      void broker.requestPrompt(
        makeBrokerRequest("p1", {
          permissionRequest: {
            id: "p1",
            sessionId: "s1",
            kind: "shell",
            toolCallId: "tc-p1",
            // extractPattern accepts "rm *" but applyGuardrails blocks rm — the
            // path that previously slipped through the card-manager predicate.
            command: "rm -rf dist",
            serverName: "",
            intention: undefined,
            warning: undefined,
            commandIdentifiers: [],
          },
        }),
      );
      await flush();

      const cards = mgr.getCards("s1");
      expect(cards[0].canPersistAlwaysAllow).toBe(false);
      expect(cards[0].buttons).not.toContain("Always allow");
      broker.resolve("p1", "allow");
    });
  });
});
