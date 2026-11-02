import * as fs from "fs";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { PermissionsConfig } from "../common/marshal-ipc-contract";
import type { KeepAwakeManager } from "./keep-awake";
import type { PermissionPolicy } from "./permission-policy";
import type { PowerManager } from "./power";
import type { RelayNotificationPublisher } from "./relay/experience-coordinator";
import { resetRelayRouteAliasesForTests } from "./relay/route-aliases";
import type { SendAndCollectResult, SessionManager } from "./sessions";
import { testDouble } from "./testing/harness";

const okResult = (text: string): SendAndCollectResult => ({ kind: "ok", text });
const timeoutResult = (text = ""): SendAndCollectResult => ({ kind: "timeout", text });
const noResponseResult = (): SendAndCollectResult => ({ kind: "no-response", text: "" });

/** Wire a mock PermissionPolicy onto a HeartbeatManager so tick() can resolve permissions. */
function wirePermissionPolicy(hb: HeartbeatManager) {
  const mockPolicy = testDouble<PermissionPolicy>({
    getGlobalPermissions: () => ({
      autoApproveReadOnly: true,
      allow: [],
      tools: {},
      servers: {},
    }),
    registerSessionPermissions: () => {},
    unregisterSessionPermissions: () => {},
    setDenyPrompt: () => {},
    clearDenyPrompt: () => {},
    markUnattended: vi.fn<() => void>(),
    clearUnattended: vi.fn<() => void>(),
  });
  hb.setPermissionPolicy(mockPolicy);
  return mockPolicy;
}

vi.mock("fs");
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn<() => string>(() => "/tmp/test-userdata"),
  },
}));

const mockedFs = vi.mocked(fs);

beforeEach(() => {
  resetRelayRouteAliasesForTests();
  vi.clearAllMocks();
  // Track persisted settings so loadSettings() reads what saveSettings() wrote
  let savedSettings: string | null = null;
  mockedFs.existsSync.mockImplementation(() => savedSettings !== null);
  mockedFs.mkdirSync.mockImplementation(() => "" as ReturnType<typeof fs.mkdirSync>); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- mock return value
  mockedFs.writeFileSync.mockImplementation((_path, data) => {
    savedSettings = typeof data === "string" ? data : JSON.stringify(data);
  });
  mockedFs.readFileSync.mockImplementation(() => savedSettings ?? "{}");
});

import { HeartbeatManager, isWorkHours } from "./heartbeat";

describe("isWorkHours", () => {
  it("returns true during work hours (Monday 10am)", () => {
    // Monday Jan 6 2025 10:00
    expect(isWorkHours(new Date(2025, 0, 6, 10, 0))).toBe(true);
  });

  it("returns false on weekends", () => {
    // Saturday Jan 4 2025 10:00
    expect(isWorkHours(new Date(2025, 0, 4, 10, 0))).toBe(false);
  });

  it("returns false before 8am", () => {
    expect(isWorkHours(new Date(2025, 0, 6, 7, 59))).toBe(false);
  });

  it("returns false at 18:00", () => {
    expect(isWorkHours(new Date(2025, 0, 6, 18, 0))).toBe(false);
  });

  it("returns true at 8:00", () => {
    expect(isWorkHours(new Date(2025, 0, 6, 8, 0))).toBe(true);
  });

  it("respects custom work days (Sun–Thu)", () => {
    const sunThu = [0, 1, 2, 3, 4]; // Sun–Thu
    // Sunday Jan 5 2025 10:00 — work day in custom config
    expect(isWorkHours(new Date(2025, 0, 5, 10, 0), sunThu)).toBe(true);
    // Friday Jan 10 2025 10:00 — off day in custom config
    expect(isWorkHours(new Date(2025, 0, 10, 10, 0), sunThu)).toBe(false);
    // Saturday Jan 4 2025 10:00 — off day in custom config
    expect(isWorkHours(new Date(2025, 0, 4, 10, 0), sunThu)).toBe(false);
  });

  it("respects custom work hours", () => {
    // Monday Jan 6 2025 — custom hours 9am–5pm
    expect(isWorkHours(new Date(2025, 0, 6, 8, 30), undefined, 9, 17)).toBe(false);
    expect(isWorkHours(new Date(2025, 0, 6, 9, 0), undefined, 9, 17)).toBe(true);
    expect(isWorkHours(new Date(2025, 0, 6, 16, 59), undefined, 9, 17)).toBe(true);
    expect(isWorkHours(new Date(2025, 0, 6, 17, 0), undefined, 9, 17)).toBe(false);
  });
});

describe("HeartbeatManager", () => {
  let hb: HeartbeatManager;

  beforeEach(() => {
    hb = new HeartbeatManager();
    hb.saveSettings({ prompt: "Check inbox" });
  });

  afterEach(() => {
    hb.destroy();
  });

  it("starts and stops timer", () => {
    expect(hb.getStatus().enabled).toBe(false);
    hb.start();
    expect(hb.getStatus().enabled).toBe(true);
    hb.stop();
    expect(hb.getStatus().enabled).toBe(false);
  });

  it("start is idempotent", () => {
    hb.start();
    hb.start(); // second call should not create second timer
    expect(hb.getStatus().enabled).toBe(true);
    hb.stop();
  });

  it("destroy clears timer", () => {
    hb.start();
    hb.destroy();
    expect(hb.getStatus().enabled).toBe(false);
  });

  it("getLogs returns logs in reverse order", () => {
    // Trigger some log entries by starting/stopping
    hb.start();
    hb.stop();
    const logs = hb.getLogs();
    expect(logs.length).toBeGreaterThanOrEqual(2);
    // Newest first
    expect(logs[0].message).toContain("stopped");
  });

  it("getSettings returns defaults when no settings file exists", () => {
    mockedFs.existsSync.mockReturnValue(false);
    const s = hb.getSettings();
    expect(s.intervalMinutes).toBe(30);
    expect(s.schedule).toBe("work-hours");
    expect(s.prompt).toBe("");
  });

  it("saveSettings persists to settings.json", () => {
    mockedFs.writeFileSync.mockImplementation(() => {});
    expect(hb.saveSettings({ prompt: "Check chat for urgent items" })).toBe(true);
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("settings.json"),
      expect.stringContaining("Check chat for urgent items"),
      "utf-8",
    );
  });

  it("saveSettings updates intervalMinutes", () => {
    mockedFs.writeFileSync.mockImplementation(() => {});
    expect(hb.saveSettings({ intervalMinutes: 60 })).toBe(true);
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("settings.json"),
      expect.stringContaining('"intervalMinutes": 60'),
      "utf-8",
    );
  });

  it("saveSettings rejects workEndHour <= workStartHour", () => {
    mockedFs.writeFileSync.mockImplementation(() => {});
    // Set valid start first
    hb.saveSettings({ workStartHour: 9 });
    // Try to set end <= start — should be silently dropped
    const before = hb.getSettings();
    hb.saveSettings({ workEndHour: 9 });
    expect(hb.getSettings().workEndHour).toBe(before.workEndHour);
    hb.saveSettings({ workEndHour: 8 });
    expect(hb.getSettings().workEndHour).toBe(before.workEndHour);
  });

  it("runNow returns false without session manager", async () => {
    const result = await hb.runNow();
    expect(result).toBe(false);
  });

  it("runNow returns false without prompt configured", async () => {
    hb.setSessionManager(testDouble<SessionManager>({ createSession: vi.fn<() => void>() }));
    mockedFs.existsSync.mockReturnValue(false);
    const result = await hb.runNow();
    expect(result).toBe(false);
  });

  it("getStatus reports running state", () => {
    expect(hb.getStatus().running).toBe(false);
  });

  it("restore starts timer if settings say enabled", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "work-hours",
        prompt: "check stuff",
      }),
    );
    hb.restore();
    expect(hb.getStatus().enabled).toBe(true);
    hb.destroy();
  });

  it("restore does not start timer if settings say disabled", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ enabled: false, intervalMinutes: 30, schedule: "work-hours", prompt: "" }),
    );
    hb.restore();
    expect(hb.getStatus().enabled).toBe(false);
  });

  it("start rejects when prompt is empty", () => {
    hb.saveSettings({ prompt: "" });
    hb.start();
    expect(hb.getStatus().enabled).toBe(false);
    const logs = hb.getLogs();
    expect(logs[0].message).toContain("No prompt configured");
  });

  it("restore auto-disables when enabled with empty prompt", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ enabled: true, intervalMinutes: 30, schedule: "work-hours", prompt: "" }),
    );
    mockedFs.writeFileSync.mockImplementation(() => {});
    vi.mocked(fs.writeFileSync).mockClear();
    hb.restore();
    expect(hb.getStatus().enabled).toBe(false);
    const logs = hb.getLogs();
    expect(logs[0].message).toContain("auto-disabling");
    // Verify the disabled state is persisted to disk (pinned to last call
    // so we don't accidentally match the beforeEach setup write)
    expect(mockedFs.writeFileSync).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.stringContaining('"enabled": false'),
      "utf-8",
    );
  });

  it("tick() calls markUnattended and clearUnattended for the heartbeat session", async () => {
    const mockPolicy = wirePermissionPolicy(hb);

    const sessionId = "hb-session-1";
    hb.setSessionManager(
      testDouble<SessionManager>({
        createSession: async () => ({ id: sessionId }),
        sendAndCollect: async () => ({ kind: "ok", text: "HEARTBEAT_OK" }),
      }),
    );

    hb.saveSettings({
      prompt: "Check emails",
      enabled: true,
      intervalMinutes: 30,
      schedule: "always",
    });
    await hb.runNow();

    expect(mockPolicy.markUnattended).toHaveBeenCalledWith(sessionId);
    expect(mockPolicy.clearUnattended).toHaveBeenCalledWith(sessionId);
  });
});

describe("HeartbeatManager tenant policy gating", () => {
  let hb: HeartbeatManager;

  beforeEach(() => {
    hb = new HeartbeatManager();
    hb.saveSettings({ prompt: "Check inbox" });
  });

  afterEach(() => {
    hb.destroy();
  });

  it("restore does not start when disableHeartbeat is true", () => {
    hb.setTenantPolicyProvider({
      get: () => ({ disableHeartbeat: true }),
      isTenantManaged: () => true,
    });
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "work-hours",
        prompt: "check",
      }),
    );
    hb.restore();
    expect(hb.getStatus().enabled).toBe(false);
  });

  it("start is blocked when disableHeartbeat is true", () => {
    hb.setTenantPolicyProvider({
      get: () => ({ disableHeartbeat: true }),
      isTenantManaged: () => true,
    });
    hb.start();
    expect(hb.getStatus().enabled).toBe(false);
  });

  it("start works when disableHeartbeat is false", () => {
    hb.setTenantPolicyProvider({
      get: () => ({ disableHeartbeat: false }),
      isTenantManaged: () => true,
    });
    hb.start();
    expect(hb.getStatus().enabled).toBe(true);
    hb.destroy();
  });

  it("start works when no tenant policy provider is set", () => {
    hb.start();
    expect(hb.getStatus().enabled).toBe(true);
    hb.destroy();
  });
});

describe("HeartbeatManager SDK event collection", () => {
  let hb: HeartbeatManager;

  beforeEach(() => {
    hb = new HeartbeatManager();
    wirePermissionPolicy(hb);
    // Make settings with a prompt available so runNow doesn't skip
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "work-hours",
        prompt: "Check for urgent items",
      }),
    );
  });

  afterEach(() => {
    hb.destroy();
  });

  function createMockSessionManager() {
    return {
      createSession: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: "hb-session-1" })),
      sendAndCollect: vi
        .fn<() => Promise<SendAndCollectResult>>()
        .mockResolvedValue(okResult("HEARTBEAT_OK All clear")),
    };
  }

  it("collects response and parses HEARTBEAT_OK", async () => {
    const mockSM = createMockSessionManager();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));
    mockSM.sendAndCollect.mockResolvedValue(okResult("HEARTBEAT_OK All clear"));

    const result = await hb.runNow();
    expect(result).toBe(true);
    const logs = hb.getLogs();
    expect(logs.some((l) => l.type === "ok" && l.message.includes("All clear"))).toBe(true);
    expect(logs.some((l) => l.type === "complete")).toBe(true);
  });

  it("detects HEARTBEAT_URGENT and calls urgent callback", async () => {
    const urgentCb = vi.fn<() => void>();
    hb.setUrgentItemCallback(urgentCb);
    const mockSM = createMockSessionManager();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));
    mockSM.sendAndCollect.mockResolvedValue(
      okResult("HEARTBEAT_URGENT|Chat|Boss needs reply|https://chat.example.com/chat"),
    );

    const result = await hb.runNow();
    expect(result).toBe(true);
    expect(urgentCb).toHaveBeenCalledWith(
      "Chat",
      "Boss needs reply",
      "https://chat.example.com/chat",
    );
    const logs = hb.getLogs();
    expect(logs.some((l) => l.type === "urgent" && l.message.includes("Boss needs reply"))).toBe(
      true,
    );
  });

  it("detects HEARTBEAT_ERROR and calls error callback (not urgent)", async () => {
    const urgentCb = vi.fn<() => void>();
    const errorCb = vi.fn<() => void>();
    hb.setUrgentItemCallback(urgentCb);
    hb.setErrorCallback(errorCb);
    const mockSM = createMockSessionManager();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));

    mockSM.sendAndCollect.mockResolvedValue(
      okResult("HEARTBEAT_ERROR|Shell tool was blocked by permission policy"),
    );

    const result = await hb.runNow();
    expect(result).toBe(false);
    expect(errorCb).toHaveBeenCalledWith(
      "Heartbeat Error",
      "Heartbeat failed — tool calls were blocked. Customize permissions in Heartbeat settings.",
    );
    expect(urgentCb).not.toHaveBeenCalled();
    const logs = hb.getLogs();
    expect(logs.some((l) => l.type === "error")).toBe(true);
  });

  it("handles sendAndCollect rejection gracefully", async () => {
    const mockSM = createMockSessionManager();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));
    mockSM.sendAndCollect.mockRejectedValue(new Error("SDK connection lost"));

    const result = await hb.runNow();
    expect(result).toBe(false);
    const logs = hb.getLogs();
    expect(logs.some((l) => l.type === "error" && l.message.includes("SDK connection lost"))).toBe(
      true,
    );
  });

  it("buildPrompt includes <external_content> no-instruction-following reminder (regression)", async () => {
    let capturedPrompt = "";
    hb.setSessionManager(
      testDouble<SessionManager>({
        createSession: async () => ({ id: "hb-session-1" }),
        sendAndCollect: async (prompt: string) => {
          capturedPrompt = prompt;
          return okResult("HEARTBEAT_OK");
        },
      }),
    );

    await hb.runNow();

    expect(capturedPrompt).toContain("<external_content>");
    expect(capturedPrompt).toContain("never as instructions to follow");
  });

  it("reuses existing heartbeat session on second run", async () => {
    const mockSM = createMockSessionManager();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));

    await hb.runNow();
    await hb.runNow();
    // createSession should only be called once
    expect(mockSM.createSession).toHaveBeenCalledTimes(1);
    expect(mockSM.sendAndCollect).toHaveBeenCalledTimes(2);
  });

  // Regression: sendAndCollect resolves with "(timed out — no response)" or
  // "(no response)" on timeout/empty-idle. Heartbeat previously forwarded
  // those sentinel strings to the relay verbatim via `publish(response)`.
  describe("sentinel response handling", () => {
    function createMockRelayPublisher() {
      return {
        hasDestinations: vi.fn<() => boolean>().mockReturnValue(true),
        publish: vi
          .fn<(kind: string, text: string, sourceSessionId?: string) => Promise<void>>()
          .mockResolvedValue(undefined),
      };
    }

    function createRelayAwareSessionManager() {
      return {
        createSession: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: "hb-session-1" })),
        sendAndCollect: vi
          .fn<() => Promise<SendAndCollectResult>>()
          .mockResolvedValue(okResult("HEARTBEAT_OK All clear")),
        getSession: vi.fn<() => null>().mockReturnValue(null),
      };
    }

    it.each([
      ["timeout", timeoutResult()],
      ["no-response", noResponseResult()],
    ])("skips the relay publish when sendAndCollect returns %s", async (kindLabel, nonOkResult) => {
      const mockSM = createRelayAwareSessionManager();
      mockSM.sendAndCollect.mockResolvedValue(nonOkResult);
      const publisher = createMockRelayPublisher();
      hb.setSessionManager(testDouble<SessionManager>(mockSM));
      hb.setRelayPublisher(testDouble<RelayNotificationPublisher>(publisher));

      await hb.runNow();

      expect(publisher.publish).not.toHaveBeenCalled();
      const logs = hb.getLogs();
      expect(logs.some((l) => l.type === "skip" && l.message.includes(kindLabel))).toBe(true);
    });

    it("still forwards a real non-OK response to the relay", async () => {
      const mockSM = createRelayAwareSessionManager();
      mockSM.sendAndCollect.mockResolvedValue(
        okResult("HEARTBEAT_URGENT|Email|Reply needed|https://x"),
      );
      const publisher = createMockRelayPublisher();
      hb.setSessionManager(testDouble<SessionManager>(mockSM));
      hb.setRelayPublisher(testDouble<RelayNotificationPublisher>(publisher));

      await hb.runNow();

      expect(publisher.publish).toHaveBeenCalledTimes(1);
      const [, text] = publisher.publish.mock.calls[0];
      expect(text).not.toContain("Session ID:");
      expect(text).toContain("- **Email**");
      expect(text).toContain("Reply needed");
      expect(text).toContain("[Open](https://x)");
      expect(text).toContain("🔔 **Items needing attention**");
      expect(text).not.toContain("HEARTBEAT_URGENT");
    });
  });

  // -------------------------------------------------------------------------
  // formatForRelay
  // -------------------------------------------------------------------------
  describe("formatForRelay", () => {
    it("formats urgent items with header and clickable links", () => {
      const raw =
        "HEARTBEAT_URGENT|PR Builds|PR #123 all green|https://ci.example.com/pr/123\n" +
        "HEARTBEAT_URGENT|On-Call|You're primary on-call today";
      const result = hb.formatForRelay(raw);
      expect(result).toBe(
        "🔔 **Items needing attention**\n\n" +
          "- **PR Builds** — PR #123 all green ([Open](https://ci.example.com/pr/123))\n" +
          "- **On-Call** — You're primary on-call today",
      );
      expect(result).not.toContain("HEARTBEAT_URGENT");
    });

    it("formats error items with warning header", () => {
      const raw = "HEARTBEAT_ERROR|Blocked from reading chat channel: 403 Forbidden";
      const result = hb.formatForRelay(raw);
      expect(result).toBe(
        "⚠️ **Heartbeat issues**\n\n- Blocked from reading chat channel: 403 Forbidden",
      );
      expect(result).not.toContain("HEARTBEAT_ERROR");
    });

    it("formats mixed urgent and error items with both headers", () => {
      const raw =
        "HEARTBEAT_URGENT|Email|Reply needed|https://mail.example.com/msg/1\n" +
        "HEARTBEAT_ERROR|Graph API returned 403";
      const result = hb.formatForRelay(raw);
      expect(result).toContain("⚠️ **Heartbeat issues**\n\n");
      expect(result).toContain("- Graph API returned 403");
      expect(result).toContain("🔔 **Items needing attention**\n\n");
      expect(result).toContain(
        "- **Email** — Reply needed ([Open](https://mail.example.com/msg/1))",
      );
    });

    it("returns raw response when no tokens are found", () => {
      const raw = "Everything looks good, no urgent items.";
      expect(hb.formatForRelay(raw)).toBe(raw);
    });

    it("strips LLM preamble text before tokens", () => {
      const raw = "Let me check your PRs.\nHEARTBEAT_URGENT|PR|Build failed|https://ci.com/run/1";
      const result = hb.formatForRelay(raw);
      expect(result).toContain("- **PR** — Build failed ([Open](https://ci.com/run/1))");
      expect(result).not.toContain("Let me check");
    });
  });
});

// ---------------------------------------------------------------------------
// HeartbeatManager permissions integration
// ---------------------------------------------------------------------------
describe("HeartbeatManager permissions", () => {
  let hb: HeartbeatManager;

  const globalPermissions: PermissionsConfig = {
    autoApproveReadOnly: false,
    tools: {},
    servers: { shell: { enabled: true, autoApprove: false } },
    allow: [],
  };

  const mockPermissionPolicy = {
    registerSessionPermissions: vi.fn<() => void>(),
    unregisterSessionPermissions: vi.fn<() => void>(),
    setDenyPrompt: vi.fn<() => void>(),
    clearDenyPrompt: vi.fn<() => void>(),
    getGlobalPermissions: vi.fn<() => PermissionsConfig>().mockReturnValue(globalPermissions),
    markUnattended: vi.fn<() => void>(),
    clearUnattended: vi.fn<() => void>(),
  };

  function createMockSM() {
    return {
      createSession: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: "hb-session-1" })),
      sendAndCollect: vi
        .fn<() => Promise<SendAndCollectResult>>()
        .mockResolvedValue(okResult("HEARTBEAT_OK All clear")),
    };
  }

  const testPermissions: PermissionsConfig = {
    autoApproveReadOnly: true,
    tools: {},
    // Non-empty so the loadSettings empty-servers heal doesn't rewrite this
    // fixture mid-test — these tests assert that the configured permissions
    // flow through to registerSessionPermissions verbatim, not heal logic.
    servers: { filesystem: { enabled: true, autoApprove: false } },
    allow: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    hb = new HeartbeatManager();
    hb.setPermissionPolicy(testDouble<PermissionPolicy>(mockPermissionPolicy));
    mockedFs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    hb.destroy();
  });

  it("calls registerSessionPermissions when permissions are configured", async () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "always",
        prompt: "check it",
        permissions: testPermissions,
      }),
    );
    const mockSM = createMockSM();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));

    await hb.runNow();

    expect(mockPermissionPolicy.registerSessionPermissions).toHaveBeenCalledWith(
      "hb-session-1",
      testPermissions,
      expect.any(Function),
    );
    // Deny-prompt catches non-approved tools (heartbeat can't show permission UI)
    expect(mockPermissionPolicy.setDenyPrompt).toHaveBeenCalledWith("hb-session-1");
    expect(mockPermissionPolicy.markUnattended).toHaveBeenCalledWith("hb-session-1");
  });

  it("uses global permissions + autoApproveReadOnly when no custom permissions configured", async () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "always",
        prompt: "check it",
      }),
    );
    const mockSM = createMockSM();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));

    await hb.runNow();

    // Should register global + autoApproveReadOnly AND set deny-prompt
    expect(mockPermissionPolicy.registerSessionPermissions).toHaveBeenCalledWith(
      "hb-session-1",
      { ...globalPermissions, autoApproveReadOnly: true },
      expect.any(Function),
    );
    // Deny-prompt catches any tool not covered by entity permissions
    expect(mockPermissionPolicy.setDenyPrompt).toHaveBeenCalledWith("hb-session-1");
    expect(mockPermissionPolicy.markUnattended).toHaveBeenCalledWith("hb-session-1");
  });

  it("session reuse across ticks re-registers permissions correctly", async () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "always",
        prompt: "check it",
        permissions: testPermissions,
      }),
    );
    const mockSM = createMockSM();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));

    // First tick: registers then unregisters
    await hb.runNow();
    expect(mockPermissionPolicy.registerSessionPermissions).toHaveBeenCalledTimes(1);
    expect(mockPermissionPolicy.unregisterSessionPermissions).toHaveBeenCalledTimes(1);

    // Second tick: re-registers on the same session
    await hb.runNow();
    expect(mockPermissionPolicy.registerSessionPermissions).toHaveBeenCalledTimes(2);
    expect(mockPermissionPolicy.unregisterSessionPermissions).toHaveBeenCalledTimes(2);
    // Same session ID reused
    expect(mockPermissionPolicy.registerSessionPermissions).toHaveBeenNthCalledWith(
      2,
      "hb-session-1",
      testPermissions,
      expect.any(Function),
    );
  });

  it("permissions change between ticks uses updated permissions", async () => {
    const updatedPermissions: PermissionsConfig = {
      autoApproveReadOnly: false,
      tools: { shell: true },
      // Non-empty so the loadSettings empty-servers heal doesn't fire.
      servers: { playwright: { enabled: true, autoApprove: true } },
      allow: ["npm test"],
    };

    // First tick: original permissions
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "always",
        prompt: "check it",
        permissions: testPermissions,
      }),
    );
    const mockSM = createMockSM();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));

    await hb.runNow();
    expect(mockPermissionPolicy.registerSessionPermissions).toHaveBeenNthCalledWith(
      1,
      "hb-session-1",
      testPermissions,
      expect.any(Function),
    );

    // Second tick: updated permissions (settings file changed)
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "always",
        prompt: "check it",
        permissions: updatedPermissions,
      }),
    );

    await hb.runNow();
    expect(mockPermissionPolicy.registerSessionPermissions).toHaveBeenNthCalledWith(
      2,
      "hb-session-1",
      updatedPermissions,
      expect.any(Function),
    );
  });

  it("cleanup calls unregisterSessionPermissions on success when permissions set", async () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "always",
        prompt: "check it",
        permissions: testPermissions,
      }),
    );
    const mockSM = createMockSM();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));

    await hb.runNow();

    expect(mockPermissionPolicy.unregisterSessionPermissions).toHaveBeenCalledWith("hb-session-1");
    expect(mockPermissionPolicy.clearDenyPrompt).toHaveBeenCalledWith("hb-session-1");
  });

  it("cleanup calls unregisterSessionPermissions on success when using default permissions", async () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "always",
        prompt: "check it",
      }),
    );
    const mockSM = createMockSM();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));

    await hb.runNow();

    expect(mockPermissionPolicy.unregisterSessionPermissions).toHaveBeenCalledWith("hb-session-1");
  });

  it("cleanup calls unregisterSessionPermissions on error when permissions set", async () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "always",
        prompt: "check it",
        permissions: testPermissions,
      }),
    );
    const mockSM = createMockSM();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));
    mockSM.sendAndCollect.mockRejectedValue(new Error("SDK connection lost"));

    await hb.runNow();

    // unregisterSessionPermissions should still be called in the finally block
    expect(mockPermissionPolicy.unregisterSessionPermissions).toHaveBeenCalledWith("hb-session-1");
    expect(mockPermissionPolicy.clearDenyPrompt).toHaveBeenCalledWith("hb-session-1");
  });

  it("cleanup calls unregisterSessionPermissions on error when using default permissions", async () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "always",
        prompt: "check it",
      }),
    );
    const mockSM = createMockSM();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));
    mockSM.sendAndCollect.mockRejectedValue(new Error("SDK connection lost"));

    await hb.runNow();

    // unregisterSessionPermissions should still be called in the finally block
    expect(mockPermissionPolicy.unregisterSessionPermissions).toHaveBeenCalledWith("hb-session-1");
  });
});

// ---------------------------------------------------------------------------
// loadSettings yoloMode → permissions migration
// ---------------------------------------------------------------------------
describe("loadSettings yoloMode migration", () => {
  let hb: HeartbeatManager;

  beforeEach(() => {
    vi.clearAllMocks();
    hb = new HeartbeatManager();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.mkdirSync.mockImplementation(() => "" as ReturnType<typeof fs.mkdirSync>); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- mock return value
    mockedFs.writeFileSync.mockImplementation(() => {});
  });

  afterEach(() => {
    hb.destroy();
  });

  const DEFAULT_MIGRATED_SERVERS = {
    filesystem: { enabled: true, autoApprove: false },
    playwright: { enabled: true, autoApprove: false },
    shell: { enabled: true, autoApprove: false },
  };

  it("migrates yoloMode: true to permissions with autoApproveReadOnly: true and default servers", () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "work-hours",
        prompt: "check stuff",
        yoloMode: true,
      }),
    );

    const settings = hb.getSettings();

    expect(settings.permissions).toEqual({
      autoApproveReadOnly: true,
      tools: {},
      servers: DEFAULT_MIGRATED_SERVERS,
      allow: [],
    });
    expect(settings).not.toHaveProperty("yoloMode");
    // Verify it was persisted to disk
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("settings.json"),
      expect.stringContaining('"autoApproveReadOnly": true'),
      "utf-8",
    );
  });

  // Design decision: yoloMode: false (deny-all) is intentionally upgraded to
  // autoApproveReadOnly: true. This normalizes all users to a safe middle ground.
  // See heartbeat.ts loadSettings() migration comment for full rationale.
  it("migrates yoloMode: false to permissions with autoApproveReadOnly: true and default servers", () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "work-hours",
        prompt: "check stuff",
        yoloMode: false,
      }),
    );

    const settings = hb.getSettings();

    expect(settings.permissions).toEqual({
      autoApproveReadOnly: true,
      tools: {},
      servers: DEFAULT_MIGRATED_SERVERS,
      allow: [],
    });
    expect(settings).not.toHaveProperty("yoloMode");
    // Verify it was persisted to disk
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("settings.json"),
      expect.stringContaining('"autoApproveReadOnly": true'),
      "utf-8",
    );
  });

  it("heals previously-migrated permissions with empty servers (backfills defaults)", () => {
    // Simulates a user migrated under the buggy migration that wrote
    // servers: {}. On load, the heal should backfill servers and persist.
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "work-hours",
        prompt: "check stuff",
        permissions: {
          autoApproveReadOnly: true,
          tools: { "tool:recall": true },
          servers: {},
          allow: [],
        },
      }),
    );

    const settings = hb.getSettings();

    expect(settings.permissions?.servers).toEqual(DEFAULT_MIGRATED_SERVERS);
    // Other customizations are preserved
    expect(settings.permissions?.autoApproveReadOnly).toBe(true);
    expect(settings.permissions?.tools).toEqual({ "tool:recall": true });
    // Heal was persisted
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("settings.json"),
      expect.stringContaining('"filesystem"'),
      "utf-8",
    );
  });

  it("does not heal when servers is already populated", () => {
    const populated = {
      autoApproveReadOnly: false,
      tools: {},
      servers: { filesystem: { enabled: true, autoApprove: false } },
      allow: [],
    };
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "work-hours",
        prompt: "check stuff",
        permissions: populated,
      }),
    );

    const settings = hb.getSettings();

    expect(settings.permissions).toEqual(populated);
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("does not migrate when permissions already exist alongside yoloMode", () => {
    const existingPermissions: PermissionsConfig = {
      autoApproveReadOnly: false,
      tools: { shell: true },
      // Non-empty so the empty-servers heal doesn't fire and confuse this test.
      servers: { filesystem: { enabled: true, autoApprove: false } },
      allow: [],
    };
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "work-hours",
        prompt: "check stuff",
        yoloMode: true,
        permissions: existingPermissions,
      }),
    );

    const settings = hb.getSettings();

    // Should keep existing permissions, not overwrite with migration defaults
    expect(settings.permissions).toEqual(existingPermissions);
    // writeFileSync should NOT be called for migration (no persist needed)
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it("does not migrate when neither yoloMode nor permissions exist", () => {
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "work-hours",
        prompt: "check stuff",
      }),
    );

    const settings = hb.getSettings();

    expect(settings.permissions).toBeUndefined();
    // writeFileSync should NOT be called for migration
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HeartbeatManager.setStatusCallback
// ---------------------------------------------------------------------------
describe("HeartbeatManager.setStatusCallback", () => {
  let hb: HeartbeatManager;

  beforeEach(() => {
    hb = new HeartbeatManager();
    wirePermissionPolicy(hb);
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "always",
        prompt: "check it",
      }),
    );
  });

  afterEach(() => {
    hb.destroy();
  });

  function createMockSM() {
    return {
      createSession: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: "hb-session-1" })),
      sendAndCollect: vi
        .fn<() => Promise<SendAndCollectResult>>()
        .mockResolvedValue(okResult("HEARTBEAT_OK All clear")),
    };
  }

  it("calls callback with (true, ...) when tick starts and (false, ...) when done", async () => {
    const statusCb = vi.fn<() => void>();
    hb.setStatusCallback(statusCb);

    const mockSM = createMockSM();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));

    await hb.runNow();

    expect(statusCb).toHaveBeenCalledWith(true, null, "Heartbeat running...");
    expect(statusCb).toHaveBeenCalledWith(false, true, "Idle");
  });

  it("calls callback with (false, ...) on error", async () => {
    const statusCb = vi.fn<() => void>();
    hb.setStatusCallback(statusCb);

    const mockSM = createMockSM();
    hb.setSessionManager(testDouble<SessionManager>(mockSM));
    mockSM.sendAndCollect.mockRejectedValue(new Error("connection failed"));

    await hb.runNow();

    const idleCalls = statusCb.mock.calls.filter((args: any[]) => args[0] === false);
    expect(idleCalls.length).toBeGreaterThan(0);
    expect(idleCalls[0]).toEqual([false, false, "Idle"]);
  });
});

// ---------------------------------------------------------------------------
// HeartbeatManager power management integration
// ---------------------------------------------------------------------------
describe("HeartbeatManager power management", () => {
  let hb: HeartbeatManager;
  const mockPowerManager = testDouble<PowerManager>({
    preventSleep: vi.fn<() => void>(),
    allowSleep: vi.fn<() => void>(),
  });
  const mockKeepAwake = testDouble<KeepAwakeManager>({
    acquire: vi.fn<() => void>(),
    release: vi.fn<() => void>(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    hb = new HeartbeatManager();
    hb.saveSettings({ prompt: "Check inbox" });
    wirePermissionPolicy(hb);
    hb.setPowerManager(mockPowerManager);
    hb.setKeepAwake(mockKeepAwake);
  });

  afterEach(() => {
    hb.destroy();
  });

  it("calls preventSleep when heartbeat starts", () => {
    hb.start();
    expect(mockPowerManager.preventSleep).toHaveBeenCalledWith("heartbeat");
  });

  it("calls keepAwake.acquire when heartbeat starts", () => {
    hb.start();
    expect(mockKeepAwake.acquire).toHaveBeenCalledWith("heartbeat");
  });

  it("does not call keepAwake.acquire when mouse wiggle is disabled", () => {
    hb.setMouseWiggleEnabledProvider(() => false);
    hb.start();
    expect(mockKeepAwake.acquire).not.toHaveBeenCalled();
    expect(mockPowerManager.preventSleep).toHaveBeenCalledWith("heartbeat");
  });

  it("does not call preventSleep when prevent sleep is disabled", () => {
    hb.setPreventSleepEnabledProvider(() => false);
    hb.start();
    expect(mockPowerManager.preventSleep).not.toHaveBeenCalled();
    expect(mockKeepAwake.acquire).toHaveBeenCalledWith("heartbeat");
  });

  it("neither prevents sleep nor acquires keepAwake when both are disabled", () => {
    hb.setMouseWiggleEnabledProvider(() => false);
    hb.setPreventSleepEnabledProvider(() => false);
    hb.start();
    expect(mockKeepAwake.acquire).not.toHaveBeenCalled();
    expect(mockPowerManager.preventSleep).not.toHaveBeenCalled();
  });

  it("stop releases keepAwake even when acquire was skipped (idempotent)", () => {
    hb.setMouseWiggleEnabledProvider(() => false);
    hb.start();
    expect(mockKeepAwake.acquire).not.toHaveBeenCalled();
    hb.stop();
    // release is safe to call without a prior acquire (Set.delete no-op)
    expect(mockKeepAwake.release).toHaveBeenCalledWith("heartbeat");
  });

  it("stop releases preventSleep even when acquire was skipped (idempotent)", () => {
    hb.setPreventSleepEnabledProvider(() => false);
    hb.start();
    expect(mockPowerManager.preventSleep).not.toHaveBeenCalled();
    hb.stop();
    // allowSleep is safe to call without a prior preventSleep (Set.delete no-op)
    expect(mockPowerManager.allowSleep).toHaveBeenCalledWith("heartbeat");
  });

  it("calls allowSleep when heartbeat stops", () => {
    hb.start();
    hb.stop();
    expect(mockPowerManager.allowSleep).toHaveBeenCalledWith("heartbeat");
  });

  it("calls keepAwake.release when heartbeat stops", () => {
    hb.start();
    hb.stop();
    expect(mockKeepAwake.release).toHaveBeenCalledWith("heartbeat");
  });

  it("calls allowSleep on destroy", () => {
    hb.start();
    hb.destroy();
    expect(mockPowerManager.allowSleep).toHaveBeenCalledWith("heartbeat");
  });

  it("calls keepAwake.release on destroy", () => {
    hb.start();
    hb.destroy();
    expect(mockKeepAwake.release).toHaveBeenCalledWith("heartbeat");
  });

  it("does not call allowSleep on destroy if timer was not active", () => {
    hb.destroy();
    expect(mockPowerManager.allowSleep).not.toHaveBeenCalled();
    expect(mockKeepAwake.release).not.toHaveBeenCalled();
  });

  it("calls preventSleep on restore when heartbeat was enabled", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 30,
        schedule: "work-hours",
        prompt: "check",
      }),
    );
    hb.restore();
    expect(mockPowerManager.preventSleep).toHaveBeenCalledTimes(1);
    expect(mockKeepAwake.acquire).toHaveBeenCalledWith("heartbeat");
  });
});

// ---------------------------------------------------------------------------
// migrateFromUserData — userData → ~/.marshal/ migration
// ---------------------------------------------------------------------------
describe("migrateFromUserData", () => {
  let hb: HeartbeatManager;

  afterEach(() => {
    hb.destroy();
  });

  it("migrates old dir with only policy.md and checklist.md (no settings.json)", () => {
    const oldDir = "/tmp/test-userdata/heartbeat";
    const copiedFiles = new Set<string>();

    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes("test-userdata") && s.endsWith("heartbeat")) return true; // oldDir exists
      if (copiedFiles.has(path.basename(s))) return true; // file available at new path after copy
      return false;
    });
    // readdirSync returns string[] without {withFileTypes:true}, but mock overload resolves to Dirent[]
    mockedFs.readdirSync.mockReturnValue(testDouble(["policy.md", "checklist.md"]));
    mockedFs.statSync.mockReturnValue(testDouble<fs.Stats>({ isFile: () => true }));
    mockedFs.readFileSync.mockImplementation((p) => {
      const s = String(p);
      if (s.includes("policy.md")) return "Check my email";
      if (s.includes("checklist.md")) return "Also check chat";
      return "";
    });
    mockedFs.copyFileSync.mockImplementation((_src, dest) => {
      copiedFiles.add(path.basename(String(dest)));
    });

    hb = new HeartbeatManager();
    const settings = hb.getSettings();

    // Should have copied both legacy files from oldDir
    expect(mockedFs.copyFileSync).toHaveBeenCalledTimes(2);
    expect(mockedFs.copyFileSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join(oldDir, "policy.md")),
      expect.stringContaining("policy.md"),
    );
    expect(mockedFs.copyFileSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join(oldDir, "checklist.md")),
      expect.stringContaining("checklist.md"),
    );
    // The prompt should be assembled from the migrated files
    expect(settings.prompt).toContain("Check my email");
    expect(settings.prompt).toContain("Also check chat");
  });

  it("migrates old dir with settings.json", () => {
    const settingsData = JSON.stringify({
      enabled: true,
      intervalMinutes: 60,
      schedule: "always",
      prompt: "hourly check",
    });
    const copiedFiles = new Set<string>();

    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes("test-userdata") && s.endsWith("heartbeat")) return true;
      if (copiedFiles.has(path.basename(s))) return true; // file available at new path after copy
      return false;
    });
    mockedFs.readdirSync.mockReturnValue(testDouble(["settings.json"]));
    mockedFs.statSync.mockReturnValue(testDouble<fs.Stats>({ isFile: () => true }));
    mockedFs.readFileSync.mockImplementation(() => settingsData);
    mockedFs.copyFileSync.mockImplementation((_src, dest) => {
      copiedFiles.add(path.basename(String(dest)));
    });

    hb = new HeartbeatManager();
    const settings = hb.getSettings();

    expect(mockedFs.copyFileSync).toHaveBeenCalledTimes(1);
    expect(settings.intervalMinutes).toBe(60);
    expect(settings.schedule).toBe("always");
    expect(settings.prompt).toBe("hourly check");
  });

  it("skips migration when new settings.json already exists", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        enabled: true,
        intervalMinutes: 15,
        schedule: "work-hours",
        prompt: "existing",
      }),
    );
    mockedFs.mkdirSync.mockImplementation(() => "" as ReturnType<typeof fs.mkdirSync>); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- mock return value
    mockedFs.writeFileSync.mockImplementation(() => {});

    hb = new HeartbeatManager();
    const settings = hb.getSettings();

    // Should NOT call copyFileSync — migration was skipped
    expect(mockedFs.copyFileSync).not.toHaveBeenCalled();
    expect(settings.prompt).toBe("existing");
  });

  it("logs error and continues when migration fails", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes("test-userdata") && s.endsWith("heartbeat")) return true;
      return false;
    });
    mockedFs.readdirSync.mockImplementation(() => {
      throw new Error("permission denied");
    });
    mockedFs.mkdirSync.mockImplementation(() => "" as ReturnType<typeof fs.mkdirSync>); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- mock return value
    mockedFs.writeFileSync.mockImplementation(() => {});
    mockedFs.readFileSync.mockReturnValue("");

    hb = new HeartbeatManager();
    // Should not throw — error is caught and logged
    const settings = hb.getSettings();
    expect(settings).toBeDefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Migration from userData failed"),
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });
});
