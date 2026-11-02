/**
 * E2E test stub responses for IPC handlers.
 *
 * With the MockCopilotClient DI approach, most session/model/permission channels
 * now fall through to real handlers (SessionManager reads/writes to disk in
 * E2E_DATA_DIR). Only channels that require external services (auth, updates,
 * etc.) remain stubbed.
 *
 * Session data is seeded to disk by e2e/marshal-fixtures.ts — including messages,
 * permission cards, and the sessions index.
 */
import fs from "node:fs";
import path from "node:path";

const MINI_MODE_STUB_ASSET =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0xQAAAAASUVORK5CYII=";

// ---------------------------------------------------------------------------
// Static stubs (returned as-is) — only for channels that need external services
// ---------------------------------------------------------------------------

export const E2E_STUBS: Record<string, unknown> = {
  "copilot:checkAuth": {
    success: true,
    isAuthenticated: true,
    login: "e2e-test",
    copilotPlan: "enterprise",
  },
  "copilot:init": { success: true, sessionId: "e2e-session", mockMode: false },
  // "copilot:send" intentionally NOT stubbed — real handler → MockCopilotSession.send()
  // "copilot:abort" intentionally NOT stubbed — real cancellation lifecycle + mock SDK abort
  // sessions:* — all fall through to real SessionManager (reads/writes E2E_DATA_DIR)
  // models:* — all fall through to real handlers (reads/writes sessions index on disk)
  // permissions:get-cards / clear-cards / list-tools — fall through to real PermissionCardManager.
  // permissions:get-config / save-config — route through CopilotPermissionsBackend → HeartbeatManager
  // (settings file at ~/.marshal/heartbeat/settings.json), NOT session files.
  // settings:* — falls through to real SettingsManager (reads E2E_DATA_DIR/marshal-settings.json)
  // mcps:* — falls through to real McpStore handlers
  // sessions:setPinned uses the real handler so pin persistence can be verified.
  "update:auth": { success: true, authenticated: true },
  "update:clear-token": { success: true },
  "update:check": { success: true, upToDate: true, currentVersion: "0.0.0", channel: "stable" },
  "update:download": { success: true, filePath: "/tmp/stub.dmg" },
  "update:install": { success: true },
  "update:restart": { success: true },
  "update:check-minimum": { success: true, blocked: false },
  "mini-mode:getState": {
    success: true,
    status: "sleeping",
    permission: null,
    pendingPermissionCount: 0,
    permissionIndex: 0,
  },
  "mini-mode:getAsset": { success: true, asset: MINI_MODE_STUB_ASSET },
  "mini-mode:showMainWindow": { success: true },
  "mini-mode:dismissApproval": { success: true },
  "mini-mode:dismissNotification": { success: true },
  "mini-mode:openUrl": { success: true },
  "dev:testMiniModeNotification": { success: true },
  "mcps:initiateOAuth": { status: "success" },
  "mcps:signOut": { status: "success" },
  "tenant:getStatus": {
    success: true,
    managed: false,
    disabledServers: [],
    disabledPermissionKinds: [],
    forcePrompt: false,
    disabledModels: [],
    disableHeartbeat: false,
    disableAutomations: false,
    disabledProviders: [],
    restrictToWorkspace: false,
    browserEgressBlockedOrigins: [],
  },
  // Override identity:get so E2E sees the same composed signed-in identity
  // shape as the real application.
  "identity:get": {
    success: true,
    identity: {
      isAuthenticated: true,
      displayName: "E2E Test",
      subtitle: "e2e-test",
      accountName: "e2e@test.com",
      avatarUrl: null,
      statusColor: "success",
      statusText: "Connected",
      integrations: [{ id: "relay", name: "Relay", connected: true }],
      signOut: { title: "Sign out?", description: "", confirmLabel: "Sign out" },
    },
  },
  // Workspace registry/lifecycle channels intentionally fall through to the
  // real manager-backed handlers so E2E exercises the canonical persisted registry.
  "workspace:createFolder": { success: true },
  "workspace:renameItem": { success: true, newPath: "/tmp/e2e-workspace/renamed" },
  "workspace:deleteItem": { success: true },
  "workspace:moveItem": { success: true, newPath: "/tmp/e2e-workspace/moved" },
  "workspace:duplicateItem": { success: true, newPath: "/tmp/e2e-workspace/file copy.txt" },
  "workspace:copyExternalFiles": { success: true, copied: 0 },
  "workspace:revealInFileManager": { success: true },
  "workspace:openFile": { success: true },
  "window-controls:getState": { success: true, isMaximized: false, isFullScreen: false },
  "window-controls:setWidth": { success: true },
  // chat-windows:open intentionally NOT stubbed — falls through to the real
  // handler so popout windows actually spawn in E2E. Required for
  // popout-mirroring.flow.test.ts; harmless for other tests because no other
  // suite invokes this IPC.
  "shell:openExternal": { success: true },
  "file:saveJson": { success: true, canceled: true },
  // preferences:get/set intentionally NOT stubbed — the real handler uses file-based
  // storage (no SDK dependency), so it falls through per CLAUDE.md stub policy.
  // backend:capabilities intentionally NOT stubbed — returns a hardcoded constant
  // with no SDK dependency, so it falls through to the real implementation.
};

// ---------------------------------------------------------------------------
// Dynamic stubs — only for channels that need filesystem access to E2E temp dir
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const E2E_DYNAMIC_STUBS: Record<string, (...args: any[]) => unknown> = {
  // File-content stubs remain deterministic; workspace registry/root/UI state
  // channels above intentionally use the real IPC handlers.
  "workspace:listDir": (dirPath: string) => {
    try {
      if (!fs.existsSync(dirPath)) return { success: true, entries: [] };
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const result = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? ("directory" as const) : ("file" as const),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { success: true, entries: result };
    } catch {
      return { success: true, entries: [] };
    }
  },
  "workspace:readFile": (filePath: string) => {
    try {
      if (!fs.existsSync(filePath)) return { success: false, error: "File not found" };
      const ext = path.extname(filePath).toLowerCase();
      const isMarkdown = [".md", ".markdown", ".mdx"].includes(ext);
      const isHtml = [".html", ".htm"].includes(ext);
      const content = fs.readFileSync(filePath, "utf-8");
      return { success: true, type: isMarkdown ? "markdown" : isHtml ? "html" : "text", content };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
  "workspace:writeFile": (filePath: string, content: string) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
};
