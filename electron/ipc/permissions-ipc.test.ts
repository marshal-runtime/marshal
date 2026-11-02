import { describe, it, expect, vi, beforeEach } from "vitest";

import type {
  PermissionCardData,
  PermissionsConfig,
  PermissionsEnvelope,
} from "../../common/marshal-ipc-contract";
import {
  DEFAULT_WORK_SERVICE_PROVIDER_IDS,
  type WorkServiceProviderSettings,
} from "../../common/provider-config";
import type { PermissionCardManager } from "../permission-card-manager";
import { testDouble } from "../testing/harness";
import type { WorkServiceToolAvailability } from "../tool-discovery";
import { buildStaticCategories } from "../tool-discovery";
import { registerPermissionsHandlers } from "./permissions-ipc";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn<() => void>(),
}));

vi.mock("../tool-discovery", () => ({
  buildStaticCategories: vi.fn<
    (settings?: WorkServiceProviderSettings, availability?: WorkServiceToolAvailability) => []
  >(() => []),
  buildMcpCategory: vi.fn<() => { key: string; name: string; groups: [] }>(() => ({
    key: "mcp",
    name: "MCP Servers",
    groups: [],
  })),
}));

const SAMPLE_ENVELOPE: PermissionsEnvelope = {
  supported: true,
  permissions: { autoApproveReadOnly: true, allow: [], tools: {}, servers: {} },
  controllable: {
    tools: { enabled: true },
    autopilotMode: { enabled: true },
    autoApproveReadOnly: { enabled: true },
    shellAllow: { enabled: true },
    shellDeny: { enabled: false },
    serverEnabled: { enabled: false },
    serverAutoApprove: { enabled: false },
    perHeartbeatScope: { enabled: false },
  },
};

function createMockPermissionsBackend() {
  return {
    getPermissions: vi.fn<() => Promise<PermissionsEnvelope>>(),
    updatePermissions:
      vi.fn<
        (
          patch: unknown,
        ) => Promise<
          | { ok: true; rejectedShellPatterns?: string[] }
          | { ok: false; reason: "cas-conflict"; latest: PermissionsEnvelope }
          | { ok: false; reason: "validation-error"; message: string }
          | { ok: false; reason: "not-supported" }
        >
      >(),
  };
}

function setup() {
  const permissionCardManager = {
    loadFromDisk: vi.fn<(sessionId: string) => void>(),
    getCards: vi.fn<(sessionId: string) => PermissionCardData[]>(() => []),
    clearSession: vi.fn<(sessionId: string) => void>(),
    resolvePolicyApprovedPending: vi.fn<
      (sessionId?: string, auditMode?: "policy-update" | "burst") => number
    >(() => 0),
  };

  const mcpStore = {
    getAll: vi.fn<() => { servers: Record<string, unknown> }>(() => ({
      servers: {
        filesystem: { builtin: true, tools: [{ name: "read_file", description: "Read a file" }] },
        playwright: { builtin: true, tools: [] },
      },
    })),
    getDiscoveryErrors: vi.fn<() => ReadonlySet<string>>(() => new Set()),
    isDiscoveryInProgress: vi.fn<() => boolean>(() => false),
  };

  const permissions = createMockPermissionsBackend();
  const settingsManager = {
    get: vi.fn<() => { permissions?: PermissionsConfig }>(() => ({
      permissions: {
        autopilotMode: false,
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: {},
      },
    })),
    update: vi.fn<(patch: { permissions?: PermissionsConfig }) => void>(),
  };

  const sessionManager = {
    getBackendProvider: vi.fn<() => { permissions: typeof permissions }>(() => ({ permissions })),
  };

  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcHandle = vi.fn<(channel: string, handler: (...args: unknown[]) => unknown) => void>(
    (channel, handler) => handlers.set(channel, handler),
  );

  registerPermissionsHandlers({
    ipcHandle: testDouble<import("./types").IpcDeps["ipcHandle"]>(ipcHandle),
    sessionManager: testDouble<import("../sessions").SessionManager>(sessionManager),
    permissionCardManager: testDouble<PermissionCardManager>(permissionCardManager),
    workServiceProviderSelection: DEFAULT_WORK_SERVICE_PROVIDER_IDS,
    mcpStore: testDouble<import("../mcp-store").McpStore>(mcpStore),
    auditLogger: testDouble<import("./types").IpcDeps["auditLogger"]>({
      log: vi.fn<import("../audit-log").AuditLogger["log"]>(),
    }),
    settingsManager: testDouble<import("./types").IpcDeps["settingsManager"]>(settingsManager),
  });

  return { permissionCardManager, mcpStore, handlers, permissions, settingsManager };
}

describe("permissions-ipc", () => {
  let permissionCardManager: ReturnType<typeof setup>["permissionCardManager"];
  let mcpStore: ReturnType<typeof setup>["mcpStore"];
  let handlers: ReturnType<typeof setup>["handlers"];
  let permissions: ReturnType<typeof setup>["permissions"];
  let settingsManager: ReturnType<typeof setup>["settingsManager"];

  beforeEach(() => {
    ({ permissionCardManager, mcpStore, handlers, permissions, settingsManager } = setup());
  });

  describe("permissions:get-cards", () => {
    it("calls loadFromDisk then getCards and returns the result", () => {
      const cards: PermissionCardData[] = [
        {
          id: "p1",
          kind: "shell",
          title: "Run",
          message: "msg",
          detail: "detail",
          buttons: ["Allow"],
          resolved: "allowed",
          output: "done",
        },
      ];
      permissionCardManager.getCards.mockReturnValue(cards);

      const handler = handlers.get("permissions:get-cards")!;
      const result = handler({}, "session-A");

      expect(permissionCardManager.loadFromDisk).toHaveBeenCalledWith("session-A");
      expect(permissionCardManager.getCards).toHaveBeenCalledWith("session-A");
      expect(result).toEqual({ success: true, cards });
    });

    it("loadFromDisk is called before getCards (merge disk cards first)", () => {
      const callOrder: string[] = [];
      permissionCardManager.loadFromDisk.mockImplementation(() => callOrder.push("load"));
      permissionCardManager.getCards.mockImplementation(() => {
        callOrder.push("get");
        return [];
      });

      const handler = handlers.get("permissions:get-cards")!;
      handler({}, "session-B");

      expect(callOrder).toEqual(["load", "get"]);
    });

    it("returns empty cards for unknown session", () => {
      const handler = handlers.get("permissions:get-cards")!;
      const result = handler({}, "nonexistent");

      expect(result).toEqual({ success: true, cards: [] });
    });
  });

  describe("permissions:clear-cards", () => {
    it("calls clearSession and returns success", () => {
      const handler = handlers.get("permissions:clear-cards")!;
      const result = handler({}, "session-A");

      expect(permissionCardManager.clearSession).toHaveBeenCalledWith("session-A");
      expect(result).toEqual({ success: true });
    });
  });

  describe("permissions:list-tools", () => {
    it("reads servers from mcpStore and returns categories", () => {
      const handler = handlers.get("permissions:list-tools")!;
      const result = handler({});

      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("categories");
      expect(mcpStore.getAll).toHaveBeenCalled();
      expect(buildStaticCategories).toHaveBeenCalledWith(
        DEFAULT_WORK_SERVICE_PROVIDER_IDS,
        undefined,
      );
    });

    it("returns success: false when mcpStore.getAll throws", () => {
      mcpStore.getAll.mockImplementationOnce(() => {
        throw new Error("boom");
      });

      const handler = handlers.get("permissions:list-tools")!;
      const result = handler({});

      expect(result).toEqual({ success: false, categories: [] });
    });
  });

  describe("permissions:get-config", () => {
    it("happy path: backend returns envelope → { success: true, envelope }", async () => {
      permissions.getPermissions.mockResolvedValue(SAMPLE_ENVELOPE);

      const result = await handlers.get("permissions:get-config")!({});

      expect(result).toEqual({
        success: true,
        envelope: {
          ...SAMPLE_ENVELOPE,
          permissions: { ...SAMPLE_ENVELOPE.permissions, autopilotMode: false },
        },
      });
      expect(permissions.getPermissions).toHaveBeenCalledOnce();
    });

    it("overlays the local Autopilot setting onto backend permissions", async () => {
      settingsManager.get.mockReturnValue({
        permissions: {
          autopilotMode: true,
          autoApproveReadOnly: false,
          allow: [],
          tools: {},
          servers: {},
        },
      });
      permissions.getPermissions.mockResolvedValue(SAMPLE_ENVELOPE);

      const result = await handlers.get("permissions:get-config")!({});

      expect(result).toMatchObject({
        success: true,
        envelope: { permissions: { autopilotMode: true } },
      });
    });

    it("backend throws → { success: false, error: message }", async () => {
      permissions.getPermissions.mockRejectedValue(new Error("connection refused"));

      const result = await handlers.get("permissions:get-config")!({});

      expect(result).toEqual({ success: false, error: "connection refused" });
    });
  });

  describe("permissions:save-config", () => {
    it("backend returns { ok: true } → { success: true }", async () => {
      permissions.updatePermissions.mockResolvedValue({ ok: true });

      const result = await handlers.get("permissions:save-config")!(
        {},
        { autoApproveReadOnly: false },
      );

      expect(result).toEqual({ success: true });
      expect(permissions.updatePermissions).toHaveBeenCalledWith({ autoApproveReadOnly: false });
    });

    it("saves Autopilot locally without passing it to backend permissions", async () => {
      const result = await handlers.get("permissions:save-config")!({}, { autopilotMode: true });

      expect(settingsManager.update).toHaveBeenCalledWith({
        permissions: {
          autopilotMode: true,
          autoApproveReadOnly: false,
          allow: [],
          tools: {},
          servers: {},
        },
      });
      expect(permissions.updatePermissions).not.toHaveBeenCalled();
      expect(permissionCardManager.resolvePolicyApprovedPending).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true });
    });

    it("does not resolve pending permission cards when Autopilot is saved off", async () => {
      const result = await handlers.get("permissions:save-config")!({}, { autopilotMode: false });

      expect(permissionCardManager.resolvePolicyApprovedPending).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it("splits Autopilot from backend permission updates", async () => {
      permissions.updatePermissions.mockResolvedValue({ ok: true });

      const result = await handlers.get("permissions:save-config")!(
        {},
        { autopilotMode: true, autoApproveReadOnly: true },
      );

      expect(settingsManager.update).toHaveBeenCalled();
      expect(permissions.updatePermissions).toHaveBeenCalledWith({ autoApproveReadOnly: true });
      expect(result).toEqual({ success: true });
    });

    it("backend returns { ok: true, rejectedShellPatterns } → { success: true, rejectedShellPatterns }", async () => {
      permissions.updatePermissions.mockResolvedValue({
        ok: true,
        rejectedShellPatterns: ["foo"],
      });

      const result = await handlers.get("permissions:save-config")!({}, { allow: ["foo"] });

      expect(result).toEqual({ success: true, rejectedShellPatterns: ["foo"] });
    });

    it("backend returns { ok: false, reason: 'cas-conflict' } → { success: false, error: 'permissions-changed-externally', conflict }", async () => {
      permissions.updatePermissions.mockResolvedValue({
        ok: false,
        reason: "cas-conflict",
        latest: SAMPLE_ENVELOPE,
      });

      const result = await handlers.get("permissions:save-config")!(
        {},
        { autoApproveReadOnly: true },
      );

      expect(result).toEqual({
        success: false,
        error: "permissions-changed-externally",
        conflict: SAMPLE_ENVELOPE,
      });
    });

    it("backend returns { ok: false, reason: 'validation-error', message } → { success: false, error: message }", async () => {
      permissions.updatePermissions.mockResolvedValue({
        ok: false,
        reason: "validation-error",
        message: "invalid pattern",
      });

      const result = await handlers.get("permissions:save-config")!(
        {},
        { autoApproveReadOnly: true },
      );

      expect(result).toEqual({ success: false, error: "invalid pattern" });
    });

    it("backend returns { ok: false, reason: 'not-supported' } → { success: false, error: 'not-supported' }", async () => {
      permissions.updatePermissions.mockResolvedValue({
        ok: false,
        reason: "not-supported",
      });

      const result = await handlers.get("permissions:save-config")!(
        {},
        { autoApproveReadOnly: true },
      );

      expect(result).toEqual({ success: false, error: "not-supported" });
    });

    it("backend THROWS (e.g. requireHB cold-start race) → { success: false, error: message }", async () => {
      permissions.updatePermissions.mockRejectedValue(new Error("HeartbeatManager not ready"));

      const result = await handlers.get("permissions:save-config")!(
        {},
        { autoApproveReadOnly: true },
      );

      expect(result).toEqual({ success: false, error: "HeartbeatManager not ready" });
    });
  });
});
