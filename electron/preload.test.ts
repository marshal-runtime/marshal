import * as fs from "fs";
import Module from "module";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type, @typescript-eslint/no-require-imports */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { IpcEventMap } from "../common/marshal-ipc-contract";
import { parseRelayAccountId, parseRelayProviderId } from "../common/relay-contract";

// Set up electron mock before loading preload
const exposedAPIs: Record<string, any> = {};
const mockInvoke = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ success: true });
const mockOn = vi.fn<(channel: string, handler: (...args: unknown[]) => void) => void>();
const mockRemoveListener =
  vi.fn<(channel: string, handler: (...args: unknown[]) => void) => void>();
const mockGetPathForFile = vi.fn<(file: File) => string>().mockReturnValue("/mock/path/file.txt");

const electronMock = {
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      exposedAPIs[name] = api;
    },
  },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
  },
  webUtils: {
    getPathForFile: mockGetPathForFile,
  },
};

function loadPreloadWithElectronMock(
  localElectronMock: typeof electronMock,
  options: { blockNodeCrypto?: boolean } = {},
) {
  const savedLoad = (Module as any)._load; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- accessing Node internal
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- accessing Node internal
  (Module as any)._load = function (request: string, ...args: unknown[]) {
    if (request === "electron") return localElectronMock;
    if (options.blockNodeCrypto && request === "node:crypto") {
      throw new Error("sandboxed preload cannot load node:crypto");
    }
    return originalLoad.call(this, request, ...args);
  };
  delete require.cache[require.resolve("./preload.cjs")];
  try {
    require("./preload.cjs");
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- restoring Node internal
    (Module as any)._load = savedLoad;
    delete require.cache[require.resolve("./preload.cjs")];
  }
}

// Intercept require('electron') at the Module level
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- accessing Node internal
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- accessing Node internal
(Module as any)._load = function (request: string, ...args: unknown[]) {
  if (request === "electron") return electronMock;
  return originalLoad.call(this, request, ...args);
};

// Now load the preload script
require("./preload.cjs");

// Restore
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- accessing Node internal
(Module as any)._load = originalLoad;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("preload", () => {
  describe("exposed APIs", () => {
    it("exposes all required API namespaces", () => {
      expect(Object.keys(exposedAPIs).sort()).toEqual([
        "activitiesAPI",
        "aiInvestigatorAPI",
        "appAPI",
        "appModeAPI",
        "automationsAPI",
        "backendAPI",
        "backgroundAPI",
        "chatWindowsAPI",
        "commandCenterAPI",
        "contextPickerAPI",
        "copilotAPI",
        "devAPI",
        "diagnosticsAPI",
        "encryptionAPI",
        "fileExportAPI",
        "gatewayAuthAPI",
        "gatewayNodeAPI",
        "goalAPI",
        "heartbeatAPI",
        "identityAPI",
        "mcpsAPI",
        "modelsAPI",
        "overlayReviewAPI",
        "permissionsAPI",
        "platform",
        "preferencesAPI",
        "relayProviderSettingsAPI",
        "remoteAccessAPI",
        "runtimeAccountsAPI",
        "runtimeAuthAPI",
        "runtimeExtensionsAPI",
        "runtimeUiAPI",
        "sessionsAPI",
        "settingsAPI",
        "shellAPI",
        "skillsAPI",
        "soulAPI",
        "telemetryAPI",
        "tenantAPI",
        "transcribeAPI",
        "uiObserveAPI",
        "updateAPI",
        "windowControlsAPI",
        "workflowsAPI",
        "workspaceAPI",
      ]);
    });

    it("does not expose the retired Memories namespace", () => {
      expect(exposedAPIs).not.toHaveProperty("memoryAPI");
    });

    it("routes the minimal goal API without a test-only harness surface", async () => {
      const fence = { goalId: "g1", epoch: 2 };
      const calls = [
        ["get", ["s1"], ["goal:get", "s1"]],
        [
          "set",
          ["s1", { objective: "Ship it", criteria: ["Tests pass"] }],
          ["goal:set", "s1", { objective: "Ship it", criteria: ["Tests pass"] }],
        ],
        [
          "updateDefinition",
          ["s1", { expectedFence: fence, patch: { objective: "Ship" } }],
          ["goal:updateDefinition", "s1", { expectedFence: fence, patch: { objective: "Ship" } }],
        ],
        [
          "updateContext",
          ["s1", { expectedFence: fence, patch: { progress: ["Done"] } }],
          ["goal:updateContext", "s1", { expectedFence: fence, patch: { progress: ["Done"] } }],
        ],
        ["pause", ["s1", fence], ["goal:pause", "s1", fence]],
        ["resume", ["s1", fence], ["goal:resume", "s1", fence]],
        [
          "steer",
          ["s1", { expectedFence: fence, instruction: "Verify" }],
          ["goal:steer", "s1", { expectedFence: fence, instruction: "Verify" }],
        ],
        ["stop", ["s1", fence], ["goal:stop", "s1", fence]],
      ] as const;

      expect(exposedAPIs.__goalHarnessMock).toBeUndefined();
      for (const [method, args, expected] of calls) {
        // eslint-disable-next-line no-await-in-loop -- each assertion observes the immediately preceding IPC call.
        await exposedAPIs.goalAPI[method](...args);
        expect(mockInvoke).toHaveBeenLastCalledWith(...expected);
      }
    });
  });

  describe("appModeAPI", () => {
    // Capture the preload-scope handler before vi.clearAllMocks() wipes mockOn.mock.calls.
    // The preload registers exactly one ipcRenderer.on("app:modeChanged") at module load.
    const modeHandler = mockOn.mock.calls.find((c) => c[0] === "app:modeChanged")?.[1] as
      | ((event: unknown, mode: string) => void)
      | undefined;

    it("exposes getLatest and onModeChanged", () => {
      expect(typeof exposedAPIs.appModeAPI.getLatest).toBe("function");
      expect(typeof exposedAPIs.appModeAPI.onModeChanged).toBe("function");
    });

    it("defaults to 'release' when MARSHAL_APP_MODE is unset", () => {
      expect(exposedAPIs.appModeAPI.getLatest()).toBe(process.env.MARSHAL_APP_MODE || "release");
    });

    it("getLatest() reflects a mode event that fires before onModeChanged is subscribed", () => {
      // This pins the race fix: the preload-scope listener captures the IPC
      // event into latestMode even when no renderer callback is registered yet.
      // Reverting to a frozen `initial` property breaks this test.
      expect(modeHandler).toBeDefined();
      modeHandler!(null, "beta");
      expect(exposedAPIs.appModeAPI.getLatest()).toBe("beta");
      // Reset for other tests
      modeHandler!(null, "release");
    });

    it("onModeChanged fans out from the single preload listener", () => {
      expect(modeHandler).toBeDefined();
      const received: string[] = [];
      const unsub = exposedAPIs.appModeAPI.onModeChanged((mode: string) => {
        received.push(mode);
      });
      modeHandler!(null, "beta");
      expect(received).toEqual(["beta"]);
      // Unsubscribe and verify no more callbacks
      unsub();
      modeHandler!(null, "dev");
      expect(received).toEqual(["beta"]); // no new entry
      // Reset
      modeHandler!(null, "release");
    });
  });

  describe("copilotAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.copilotAPI).sort()).toEqual([
        "abort",
        "checkAuth",
        "destroy",
        "getSystemInfo",
        "getVersion",
        "init",
        "login",
        "onAuthError",
        "onLoginFailed",
        "openDeviceFlowPage",
        "resolvePermission",
        "saveImage",
        "send",
        "signOut",
        "startDeviceFlow",
        "steer",
      ]);
    });

    it("init invokes correct IPC channel", () => {
      (exposedAPIs.copilotAPI.init as Function)(); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API;
      expect(mockInvoke).toHaveBeenCalledWith("copilot:init");
    });

    it("send passes all arguments to IPC", () => {
      const attachments = [{ type: "file", path: "/tmp/test", displayName: "test" }];
      // 4th arg is the renderer-generated clientMessageId — shared between
      // the optimistic message and the broadcast for cross-window dedup.
      (exposedAPIs.copilotAPI.send as Function)("hello", "session-1", attachments, "msg-id-1"); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API;
      expect(mockInvoke).toHaveBeenCalledWith(
        "copilot:send",
        "hello",
        "session-1",
        attachments,
        "msg-id-1",
      );
    });

    it("abort passes sessionId to IPC", () => {
      (exposedAPIs.copilotAPI.abort as Function)("session-1"); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API;
      expect(mockInvoke).toHaveBeenCalledWith("copilot:abort", "session-1");
    });

    it("steer passes all arguments to one IPC call", () => {
      const attachments = [{ type: "file", path: "/tmp/test", displayName: "test" }];
      (exposedAPIs.copilotAPI.steer as Function)("redirect", "session-1", attachments, "msg-2"); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API;
      expect(mockInvoke).toHaveBeenCalledWith(
        "copilot:steer",
        "redirect",
        "session-1",
        attachments,
        "msg-2",
      );
    });

    it("saveImage passes base64 and mime to IPC", () => {
      (exposedAPIs.copilotAPI.saveImage as Function)("abc123", "image/png"); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API;
      expect(mockInvoke).toHaveBeenCalledWith("copilot:saveImage", "abc123", "image/png");
    });
  });

  describe("overlayReviewAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.overlayReviewAPI).sort()).toEqual([
        "claim",
        "launch",
        "onError",
        "onPending",
      ]);
    });

    it("launch invokes correct IPC channel", () => {
      const request = { sessionId: "session-1", sessionTitle: "A session" };
      (exposedAPIs.overlayReviewAPI.launch as Function)(request); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith("overlay-review:launch", request);
    });

    it("claim invokes correct IPC channel", () => {
      (exposedAPIs.overlayReviewAPI.claim as Function)("session-1"); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith("overlay-review:claim", "session-1");
    });

    it("onPending subscribes and unsubscribes from the IPC event", () => {
      const callback = vi.fn<(payload: unknown) => void>();
      const unsubscribe = (exposedAPIs.overlayReviewAPI.onPending as Function)(callback); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockOn).toHaveBeenCalledWith("overlay-review:pending", expect.any(Function));
      const handler = mockOn.mock.calls.find((call) => call[0] === "overlay-review:pending")?.[1];
      expect(handler).toBeDefined();
      handler?.({}, { sessionId: "session-1" });
      expect(callback).toHaveBeenCalledWith({ sessionId: "session-1" });

      unsubscribe();
      expect(mockRemoveListener).toHaveBeenCalledWith("overlay-review:pending", handler);
    });

    it("onError subscribes and unsubscribes from the IPC event", () => {
      const callback = vi.fn<(payload: unknown) => void>();
      const unsubscribe = (exposedAPIs.overlayReviewAPI.onError as Function)(callback); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockOn).toHaveBeenCalledWith("overlay-review:error", expect.any(Function));
      const handler = mockOn.mock.calls.find((call) => call[0] === "overlay-review:error")?.[1];
      expect(handler).toBeDefined();
      handler?.({}, { message: "Overlay failed" });
      expect(callback).toHaveBeenCalledWith({ message: "Overlay failed" });

      unsubscribe();
      expect(mockRemoveListener).toHaveBeenCalledWith("overlay-review:error", handler);
    });
  });

  describe("runtimeUiAPI placements", () => {
    it("exposes placement methods and routes invokes", () => {
      expect(Object.keys(exposedAPIs.runtimeUiAPI)).toEqual(
        expect.arrayContaining(["getPlacements", "activatePlacement"]),
      );
      const scope = { sessionId: "session-1", workspaceName: "workspace-1" };
      const request = {
        ...scope,
        extensionId: "@fixture/overlay",
        applicationId: "overlay-review",
        idempotencyKey: "placement-1",
      };

      (exposedAPIs.runtimeUiAPI.getPlacements as Function)(scope); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      (exposedAPIs.runtimeUiAPI.activatePlacement as Function)(request); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API

      expect(mockInvoke).toHaveBeenCalledWith("runtime-ui:getPlacements", scope);
      expect(mockInvoke).toHaveBeenCalledWith("runtime-ui:activatePlacement", request);
    });

    it("exposes the scoped Runtime extension catalog methods", () => {
      expect(Object.keys(exposedAPIs.runtimeExtensionsAPI).sort()).toEqual([
        "clearProvider",
        "configure",
        "disable",
        "enable",
        "install",
        "installLocal",
        "onChanged",
        "remove",
        "repairContractConflict",
        "search",
        "setProvider",
        "status",
        "update",
      ]);
      const request = { sessionId: "session-1", workspaceName: "workspace-1", search: {} };
      (exposedAPIs.runtimeExtensionsAPI.search as Function)(request); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith("runtime-extensions:search", request);
    });
  });

  describe("sessionsAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.sessionsAPI).sort()).toEqual([
        "ackView",
        "compact",
        "create",
        "createMain",
        "createOrReuseEmpty",
        "delete",
        "deleteAll",
        "get",
        "getMessages",
        "getToolCallDetails",
        "getView",
        "list",
        "listWithOptions",
        "markRead",
        "messageSubagent",
        "onHydrationChanged",
        "onListChanged",
        "onMetadataChanged",
        "onStatusDelta",
        "onSwitchTo",
        "onViewEvent",
        "patchQuestionSelection",
        "rename",
        "resyncView",
        "sendReviewComments",
        "setModel",
        "setPinned",
        "subscribeView",
        "switch",
        "unsubscribeView",
      ]);
    });

    it("forwards legacy and delta metadata events through the compatible callback shape", () => {
      const callback =
        vi.fn<(sessionId: string, changes?: { name?: string; updatedAt?: string }) => void>();
      const unsubscribe = (exposedAPIs.sessionsAPI.onMetadataChanged as Function)(callback); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      const handler = mockOn.mock.calls.find((call) => call[0] === "session:metadata-changed")?.[1];
      expect(handler).toBeDefined();

      handler?.({}, "legacy-session");
      handler?.({}, { sessionId: "delta-session", changes: { name: "Renamed" } });

      expect(callback).toHaveBeenNthCalledWith(1, "legacy-session");
      expect(callback).toHaveBeenNthCalledWith(2, "delta-session", { name: "Renamed" });
      unsubscribe();
      expect(mockRemoveListener).toHaveBeenCalledWith("session:metadata-changed", handler);
    });

    it("create passes model, soul, and options to IPC", () => {
      (exposedAPIs.sessionsAPI.create as Function)("gpt-4", "sassy", { name: "test" }); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API;
      expect(mockInvoke).toHaveBeenCalledWith("sessions:create", "gpt-4", "sassy", {
        name: "test",
      });
    });

    it("createMain passes model, soul, and selection to IPC", () => {
      const selection = {
        workspaceBinding: {
          name: "Project",
          identity: { version: 1, device: "1", inode: "2", birthtimeNs: "3" },
        },
        repositoryAgent: {
          name: "Reviewer",
          path: ".github/agents/reviewer.agent.md",
          identity: {
            version: 1,
            normalizedPath: ".github/agents/reviewer.agent.md",
            declaredName: "Reviewer",
            contentDigest: "reviewer-v1",
          },
        },
      };
      (exposedAPIs.sessionsAPI.createMain as Function)("gpt-5", "default", selection); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith("sessions:createMain", "gpt-5", "default", selection);
    });

    it("rename passes sessionId, name, and optional aiGeneratedTitle to IPC", () => {
      (exposedAPIs.sessionsAPI.rename as Function)("s1", "My Chat"); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith("sessions:rename", "s1", "My Chat", undefined);

      mockInvoke.mockClear();
      (exposedAPIs.sessionsAPI.rename as Function)("s1", "Quick Title", "Quick Title"); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith(
        "sessions:rename",
        "s1",
        "Quick Title",
        "Quick Title",
      );
    });
  });

  describe("modelsAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.modelsAPI).sort()).toEqual([
        "getDefault",
        "getDefaultContextTier",
        "getDefaultReasoningEffort",
        "getSessionContextTier",
        "getSessionModel",
        "getSessionReasoningEffort",
        "getTierDefaults",
        "list",
        "onChanged",
        "setDefault",
        "setDefaultContextTier",
        "setDefaultReasoningEffort",
        "setSessionContextTier",
        "setSessionReasoningEffort",
        "setTierDefaultContextTier",
        "setTierDefaultModel",
        "setTierDefaultReasoningEffort",
      ]);
    });
  });

  describe("soulAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.soulAPI).sort()).toEqual([
        "getDefault",
        "getGreeting",
        "getSessionSoul",
        "list",
        "setDefault",
      ]);
    });
  });

  describe("skillsAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.skillsAPI).sort()).toEqual([
        "add",
        "delete",
        "export",
        "importBundle",
        "importContents",
        "importFile",
        "importPath",
        "importUrl",
        "list",
        "onChanged",
        "openFile",
        "update",
      ]);
    });
  });

  describe("heartbeatAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.heartbeatAPI).sort()).toEqual([
        "getLogs",
        "getSettings",
        "runNow",
        "saveSettings",
        "status",
        "toggle",
      ]);
    });
  });

  describe("automationsAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.automationsAPI).sort()).toEqual([
        "create",
        "delete",
        "exportAutomation",
        "getAllHistory",
        "getConditionStatus",
        "getCurrentRun",
        "getHistory",
        "importAutomation",
        "importBundle",
        "importFromGithub",
        "list",
        "onChanged",
        "runNow",
        "toggle",
        "update",
      ]);
    });
  });

  describe("backgroundAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.backgroundAPI).sort()).toEqual([
        "getSettings",
        "saveSettings",
      ]);
    });

    it("getSettings invokes background:getSettings IPC channel", () => {
      (exposedAPIs.backgroundAPI.getSettings as Function)(); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith("background:getSettings");
    });

    it("saveSettings passes updates to background:saveSettings IPC channel", () => {
      const updates = { enabled: true, runOnStartup: false };
      (exposedAPIs.backgroundAPI.saveSettings as Function)(updates); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith("background:saveSettings", updates);
    });
  });

  describe("settingsAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.settingsAPI).sort()).toEqual([
        "get",
        "getRuntimeSelection",
        "getShowHideShortcutStatus",
        "onChanged",
        "onToggle",
        "openFile",
        "pickWorkspaceDir",
        "pickWorktreeDir",
        "save",
        "switchRuntime",
      ]);
    });

    describe("relayProviderSettingsAPI", () => {
      it("exposes provider lifecycle methods and event subscriptions", () => {
        expect(Object.keys(exposedAPIs.relayProviderSettingsAPI).sort()).toEqual([
          "connect",
          "disconnect",
          "list",
          "onChanged",
          "onSetupChanged",
          "provision",
          "relink",
          "reset",
        ]);
      });

      it("passes the explicit provider identity to connect", () => {
        const request = {
          providerKey: "whatsapp",
          runtimeProviderId: "whatsapp-baileys",
          accountId: "marshal",
        };
        exposedAPIs.relayProviderSettingsAPI.connect(request);
        expect(mockInvoke).toHaveBeenCalledWith("relay-provider-settings:connect", request);
      });

      it("forwards setup snapshots without reshaping them", () => {
        const callback =
          vi.fn<(event: IpcEventMap["relay-provider-settings:setup-changed"]) => void>();
        const unsubscribe = exposedAPIs.relayProviderSettingsAPI.onSetupChanged(callback);
        const registration = mockOn.mock.calls.find(
          ([channel]) => channel === "relay-provider-settings:setup-changed",
        );
        const event: IpcEventMap["relay-provider-settings:setup-changed"] = {
          providerKey: "whatsapp",
          runtimeProviderId: "whatsapp-baileys",
          snapshot: {
            account: {
              providerId: parseRelayProviderId("whatsapp-baileys"),
              accountId: parseRelayAccountId("marshal-primary"),
            },
            state: "qr",
            updatedAt: "2026-08-07T00:00:00.000Z",
            qr: { payload: "ephemeral-qr" },
          },
        };

        registration?.[1]({}, event);

        expect(callback).toHaveBeenCalledWith(event);
        unsubscribe();
        expect(mockRemoveListener).toHaveBeenCalledWith(
          "relay-provider-settings:setup-changed",
          registration?.[1],
        );
      });
    });

    it("getRuntimeSelection invokes the startup-selection IPC channel", () => {
      exposedAPIs.settingsAPI.getRuntimeSelection();
      expect(mockInvoke).toHaveBeenCalledWith("settings:getRuntimeSelection");
    });

    it("switchRuntime invokes the runtime-switch IPC channel", () => {
      exposedAPIs.settingsAPI.switchRuntime("codex");
      expect(mockInvoke).toHaveBeenCalledWith("settings:switchRuntime", "codex");
    });
  });

  describe("appAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.appAPI).sort()).toEqual(["getDefaultWorkspaceDir"]);
    });
  });

  describe("mcpsAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.mcpsAPI).sort()).toEqual([
        "add",
        "initiateOAuth",
        "installCatalog",
        "list",
        "onOAuthCompleted",
        "onOAuthRequired",
        "onServerStatus",
        "onToolsUpdated",
        "openEnvFile",
        "openFile",
        "rediscover",
        "remove",
        "setExposeAsGatewayNodeCommand",
        "signOut",
        "updateConfig",
      ]);
    });
  });

  describe("contextPickerAPI", () => {
    it("exposes only runtime-backed search", () => {
      expect(Object.keys(exposedAPIs.contextPickerAPI).sort()).toEqual(["search"]);
      (exposedAPIs.contextPickerAPI.search as Function)("alice", ["People"]); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith("contextPicker:search", "alice", ["People"]);
    });
  });

  describe("activitiesAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.activitiesAPI).sort()).toEqual(["getAll"]);
    });
  });

  describe("windowControlsAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.windowControlsAPI).sort()).toEqual([
        "close",
        "getState",
        "minimize",
        "onFullScreenChanged",
        "onMaximizeChanged",
        "setWidth",
        "toggleMaximize",
      ]);
    });

    it("minimize invokes the correct IPC channel", () => {
      (exposedAPIs.windowControlsAPI.minimize as Function)(); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith("window-controls:minimize");
    });

    it("toggleMaximize invokes the correct IPC channel", () => {
      (exposedAPIs.windowControlsAPI.toggleMaximize as Function)(); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith("window-controls:toggleMaximize");
    });
  });

  describe("workspaceAPI", () => {
    it("subscribes to workspace registry changes separately from filesystem changes", () => {
      const callback = vi.fn<() => void>();
      const unsubscribe = exposedAPIs.workspaceAPI.onWorkspaceRegistryChange(callback);
      const registration = mockOn.mock.calls.find(
        ([channel]) => channel === "workspace:registry-changed",
      );
      expect(registration).toBeDefined();

      registration?.[1]();
      expect(callback).toHaveBeenCalledOnce();
      unsubscribe();
      expect(mockRemoveListener).toHaveBeenCalledWith(
        "workspace:registry-changed",
        registration?.[1],
      );
    });

    it("listRepositoryAgents passes the workspace name to IPC", () => {
      (exposedAPIs.workspaceAPI.listRepositoryAgents as Function)("Project"); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith("workspace:listRepositoryAgents", "Project");
    });

    it("getPathForFile delegates to webUtils.getPathForFile", () => {
      const dummyFile = new File(["content"], "test.txt");
      const result = (exposedAPIs.workspaceAPI.getPathForFile as Function)(dummyFile); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockGetPathForFile).toHaveBeenCalledWith(dummyFile);
      expect(result).toBe("/mock/path/file.txt");
    });

    it("copyExternalFiles authorizes native paths before copying with returned token", async () => {
      const firstFile = new File(["one"], "one.txt");
      const secondFile = new File(["two"], "two.txt");
      mockGetPathForFile
        .mockReturnValueOnce("C:\\Downloads\\one.txt")
        .mockReturnValueOnce("C:\\Downloads\\two.txt");
      mockInvoke
        .mockResolvedValueOnce({ success: true, importToken: "import-token" })
        .mockResolvedValueOnce({ success: true, copied: 2 });

      const result = await exposedAPIs.workspaceAPI.copyExternalFiles(
        [firstFile, secondFile],
        "C:\\Workspace",
      );

      expect(mockGetPathForFile).toHaveBeenCalledWith(firstFile);
      expect(mockGetPathForFile).toHaveBeenCalledWith(secondFile);
      expect(mockInvoke).toHaveBeenNthCalledWith(
        1,
        "workspace:authorizeExternalFiles",
        expect.any(String),
        ["C:\\Downloads\\one.txt", "C:\\Downloads\\two.txt"],
      );
      expect(mockInvoke).toHaveBeenNthCalledWith(
        2,
        "workspace:copyExternalFiles",
        "import-token",
        "C:\\Workspace",
      );
      expect(result).toEqual({ success: true, copied: 2 });
    });

    it("copyExternalFiles registers a bridge token before authorizing native paths", async () => {
      const captured: Record<string, any> = {};
      const localInvoke = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: true, importToken: "import-token" })
        .mockResolvedValueOnce({ success: true, copied: 1 });
      const localGetPathForFile = vi
        .fn<(file: File) => string>()
        .mockReturnValue("C:\\Drop\\one.txt");
      loadPreloadWithElectronMock({
        ...electronMock,
        contextBridge: {
          exposeInMainWorld: (name: string, api: unknown) => {
            captured[name] = api;
          },
        },
        ipcRenderer: {
          ...electronMock.ipcRenderer,
          invoke: localInvoke,
        },
        webUtils: {
          getPathForFile: localGetPathForFile,
        },
      });

      const result = await captured.workspaceAPI.copyExternalFiles(
        [new File(["one"], "one.txt")],
        "C:\\Workspace",
      );
      const bridgeToken = localInvoke.mock.calls[0]?.[1];

      expect(localInvoke).toHaveBeenNthCalledWith(
        1,
        "workspace:registerExternalFileImportBridge",
        expect.any(String),
      );
      expect(localInvoke).toHaveBeenNthCalledWith(
        2,
        "workspace:authorizeExternalFiles",
        bridgeToken,
        ["C:\\Drop\\one.txt"],
      );
      expect(localInvoke).toHaveBeenNthCalledWith(
        3,
        "workspace:copyExternalFiles",
        "import-token",
        "C:\\Workspace",
      );
      expect(result).toEqual({ success: true, copied: 1 });
    });

    it("uses a secure bridge token fallback when Web Crypto randomUUID is unavailable", () => {
      const captured: Record<string, any> = {};
      const localInvoke = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValue({ success: true });
      const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
      const mathRandom = vi.spyOn(Math, "random").mockImplementation(() => {
        throw new Error("Math.random fallback must not be used");
      });

      try {
        Object.defineProperty(globalThis, "crypto", {
          configurable: true,
          value: undefined,
        });
        loadPreloadWithElectronMock({
          ...electronMock,
          contextBridge: {
            exposeInMainWorld: (name: string, api: unknown) => {
              captured[name] = api;
            },
          },
          ipcRenderer: {
            ...electronMock.ipcRenderer,
            invoke: localInvoke,
          },
        });
      } finally {
        mathRandom.mockRestore();
        if (cryptoDescriptor) {
          Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
        }
      }

      expect(localInvoke).toHaveBeenCalledWith(
        "workspace:registerExternalFileImportBridge",
        expect.stringMatching(/^[a-f0-9]{32}$/),
      );
      expect(captured.workspaceAPI).toBeDefined();
    });

    it("loads in a sandboxed preload when Web Crypto is available", () => {
      const captured: Record<string, any> = {};
      const localInvoke = vi
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValue({ success: true });
      const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");

      try {
        Object.defineProperty(globalThis, "crypto", {
          configurable: true,
          value: { randomUUID: () => "sandbox-token" },
        });
        loadPreloadWithElectronMock(
          {
            ...electronMock,
            contextBridge: {
              exposeInMainWorld: (name: string, api: unknown) => {
                captured[name] = api;
              },
            },
            ipcRenderer: {
              ...electronMock.ipcRenderer,
              invoke: localInvoke,
            },
          },
          { blockNodeCrypto: true },
        );
      } finally {
        if (cryptoDescriptor) {
          Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
        }
      }

      expect(localInvoke).toHaveBeenCalledWith(
        "workspace:registerExternalFileImportBridge",
        "sandbox-token",
      );
      expect(captured.copilotAPI?.checkAuth).toBeTypeOf("function");
    });

    it("does not expose raw external file authorization methods", () => {
      expect(exposedAPIs.workspaceAPI.authorizeExternalFiles).toBeUndefined();
      expect(exposedAPIs.workspaceAPI.registerExternalFileImportBridge).toBeUndefined();
    });

    it("copyExternalFiles accepts File objects from a different JavaScript realm", async () => {
      const OriginalFile = globalThis.File;
      const file = new OriginalFile(["safe"], "safe.txt");
      mockGetPathForFile.mockReturnValueOnce("C:\\Downloads\\safe.txt");
      mockInvoke
        .mockResolvedValueOnce({ success: true, importToken: "safe-token" })
        .mockResolvedValueOnce({ success: true, copied: 1 });

      try {
        globalThis.File = class OtherRealmFile extends OriginalFile {};

        await exposedAPIs.workspaceAPI.copyExternalFiles([file], "C:\\Workspace");
      } finally {
        globalThis.File = OriginalFile;
      }

      expect(mockGetPathForFile).toHaveBeenCalledWith(file);
      expect(mockInvoke).toHaveBeenNthCalledWith(
        1,
        "workspace:authorizeExternalFiles",
        expect.any(String),
        ["C:\\Downloads\\safe.txt"],
      );
      expect(mockInvoke).toHaveBeenNthCalledWith(
        2,
        "workspace:copyExternalFiles",
        "safe-token",
        "C:\\Workspace",
      );
    });

    it("copyExternalFiles ignores non-File values instead of forwarding them as paths", async () => {
      const file = new File(["safe"], "safe.txt");
      mockGetPathForFile.mockReturnValueOnce("C:\\Downloads\\safe.txt");
      mockInvoke
        .mockResolvedValueOnce({ success: true, importToken: "safe-token" })
        .mockResolvedValueOnce({ success: true, copied: 1 });

      await exposedAPIs.workspaceAPI.copyExternalFiles(
        ["C:\\Secrets\\raw.txt", { path: "C:\\Secrets\\object.txt" }, file],
        "C:\\Workspace",
      );

      expect(mockGetPathForFile).toHaveBeenCalledTimes(1);
      expect(mockGetPathForFile).toHaveBeenCalledWith(file);
      expect(mockInvoke).toHaveBeenNthCalledWith(
        1,
        "workspace:authorizeExternalFiles",
        expect.any(String),
        ["C:\\Downloads\\safe.txt"],
      );
      expect(mockInvoke).toHaveBeenNthCalledWith(
        2,
        "workspace:copyExternalFiles",
        "safe-token",
        "C:\\Workspace",
      );
    });
  });

  describe("gatewayAuthAPI", () => {
    it("exposes all expected methods", () => {
      expect(Object.keys(exposedAPIs.gatewayAuthAPI).sort()).toEqual([
        "approveDevice",
        "cancelPairing",
        "getState",
        "listPendingDevices",
        "onStateChange",
        "signIn",
        "signOut",
      ]);
    });

    it("getState invokes the correct IPC channel", () => {
      (exposedAPIs.gatewayAuthAPI.getState as Function)(); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith("gatewayAuth:getState");
    });

    it("signOut invokes the correct IPC channel", () => {
      (exposedAPIs.gatewayAuthAPI.signOut as Function)(); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith("gatewayAuth:signOut");
    });

    it("signIn forwards the cred to the correct IPC channel", () => {
      const cred = { mode: "hosted", roleMode: "operator-and-node" };
      (exposedAPIs.gatewayAuthAPI.signIn as Function)(cred); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API
      expect(mockInvoke).toHaveBeenCalledWith("gatewayAuth:signIn", cred);
    });

    it("onStateChange returns unsubscribe function and listens to state changes", () => {
      const callback = vi.fn<(state: unknown) => void>();
      const unsubscribe = (exposedAPIs.gatewayAuthAPI.onStateChange as Function)(callback); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- untyped preload API

      expect(mockOn).toHaveBeenCalledWith("gatewayAuth:stateChange", expect.any(Function));

      const handler = mockOn.mock.calls[0][1];
      const mockState = { authenticated: true };
      handler(undefined, mockState);

      expect(callback).toHaveBeenCalledWith(mockState);

      mockOn.mockClear();
      mockRemoveListener.mockClear();
      unsubscribe();
      expect(mockRemoveListener).toHaveBeenCalledWith(
        "gatewayAuth:stateChange",
        expect.any(Function),
      );
    });
  });

  describe("preload matches IPC contract", () => {
    // Extract invoke method names from IpcInvokeMap (not IpcEventMap) for a namespace prefix.
    // Converts channel suffix from kebab-case to camelCase (e.g., "delete-all" → "deleteAll").
    function extractInvokeMethods(contractSrc: string, nsPrefix: string): string[] {
      // Extract just the IpcInvokeMap block (handle both LF and CRLF line endings)
      const declarationStart = contractSrc.indexOf("export interface IpcInvokeMap");
      const invokeStart = contractSrc.indexOf("{", declarationStart);
      const invokeEndLF = contractSrc.indexOf("\n}\n", invokeStart);
      const invokeEndCRLF = contractSrc.indexOf("\r\n}\r\n", invokeStart);
      const invokeEnd = invokeEndLF >= 0 ? invokeEndLF : invokeEndCRLF;
      const invokeBlock = contractSrc.slice(invokeStart, invokeEnd);

      const methods: string[] = [];
      const escaped = nsPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`"${escaped}:([^"]+)"`, "g");
      let m;
      while ((m = re.exec(invokeBlock)) !== null) {
        const suffix = m[1];
        const camel = suffix.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        methods.push(camel);
      }
      return methods.sort();
    }

    // Extract manually declared members (event listeners, non-IPC methods) from interface bodies.
    function extractManualMembers(contractSrc: string, interfaceName: string): string[] {
      const lines = contractSrc.split("\n");
      let inBlock = false;
      const members: string[] = [];
      for (const line of lines) {
        if (line.match(new RegExp(`^export interface ${interfaceName}\\b`))) {
          inBlock = true;
          continue;
        }
        if (inBlock && line.match(/^}/)) break;
        if (inBlock) {
          const m = line.match(/^ {2}(\w+)\??\s*[:(]/);
          if (m) members.push(m[1]);
        }
      }
      return members;
    }

    const contractSrc = fs.readFileSync(
      path.join(__dirname, "..", "common", "marshal-ipc-contract.ts"),
      "utf-8",
    );

    // Method name overrides: channel suffix → actual API method name
    // (when the method name doesn't match kebab-to-camel of the channel suffix)
    const methodOverrides: Record<string, Record<string, string>> = {
      sessions: { tokenUsage: "getTokenUsage" },
      automations: { export: "exportAutomation", import: "importAutomation" },
    };

    function getExpectedMethods(nsPrefix: string, interfaceName: string): string[] {
      const invoke = extractInvokeMethods(contractSrc, nsPrefix);
      const overrides = methodOverrides[nsPrefix] ?? {};
      const remapped = invoke.map((m) => overrides[m] ?? m);
      const manual = extractManualMembers(contractSrc, interfaceName);
      return [...new Set([...remapped, ...manual])].sort();
    }

    it("copilotAPI methods match CopilotAPI", () => {
      const expected = getExpectedMethods("copilot", "CopilotAPI");
      const preloadMethods = Object.keys(exposedAPIs.copilotAPI).sort();
      for (const method of expected) {
        expect(preloadMethods, `Missing method in preload: ${method}`).toContain(method);
      }
    });

    it("sessionsAPI methods match SessionsAPI", () => {
      const expected = getExpectedMethods("sessions", "SessionsAPI");
      expect(Object.keys(exposedAPIs.sessionsAPI).sort()).toEqual(expected);
    });

    it("modelsAPI methods match ModelsAPI", () => {
      const expected = getExpectedMethods("models", "ModelsAPI");
      expect(Object.keys(exposedAPIs.modelsAPI).sort()).toEqual(expected);
    });

    it("skillsAPI methods match SkillsAPI", () => {
      const expected = getExpectedMethods("skills", "SkillsAPI");
      expect(Object.keys(exposedAPIs.skillsAPI).sort()).toEqual(expected);
    });

    it("heartbeatAPI methods match HeartbeatAPI", () => {
      const expected = getExpectedMethods("heartbeat", "HeartbeatAPI");
      expect(Object.keys(exposedAPIs.heartbeatAPI).sort()).toEqual(expected);
    });

    it("relayProviderSettingsAPI methods match RelayProviderSettingsAPI", () => {
      const expected = getExpectedMethods("relay-provider-settings", "RelayProviderSettingsAPI");
      expect(Object.keys(exposedAPIs.relayProviderSettingsAPI).sort()).toEqual(expected);
    });

    it("backgroundAPI methods match BackgroundAPI", () => {
      const expected = getExpectedMethods("background", "BackgroundAPI");
      expect(Object.keys(exposedAPIs.backgroundAPI).sort()).toEqual(expected);
    });

    it("windowControlsAPI methods match WindowControlsAPI", () => {
      const expected = getExpectedMethods("window-controls", "WindowControlsAPI");
      expect(Object.keys(exposedAPIs.windowControlsAPI).sort()).toEqual(expected);
    });

    it("telemetryAPI methods match TelemetryAPI", () => {
      const expected = getExpectedMethods("telemetry", "TelemetryAPI");
      expect(Object.keys(exposedAPIs.telemetryAPI).sort()).toEqual(expected);
    });

    it("diagnosticsAPI methods match DiagnosticsAPI", () => {
      const expected = getExpectedMethods("diagnostics", "DiagnosticsAPI");
      expect(Object.keys(exposedAPIs.diagnosticsAPI).sort()).toEqual(expected);
    });

    it("mcpsAPI methods match McpsAPI", () => {
      const expected = getExpectedMethods("mcps", "McpsAPI");
      expect(Object.keys(exposedAPIs.mcpsAPI).sort()).toEqual(expected);
    });

    it("activitiesAPI methods match ActivitiesAPI", () => {
      const expected = getExpectedMethods("activities", "ActivitiesAPI");
      expect(Object.keys(exposedAPIs.activitiesAPI).sort()).toEqual(expected);
    });

    it("commandCenterAPI methods match CommandCenterAPI", () => {
      const expected = getExpectedMethods("command-center", "CommandCenterAPI");
      expect(Object.keys(exposedAPIs.commandCenterAPI).sort()).toEqual(expected);
    });

    it("shellAPI methods match ShellAPI", () => {
      const expected = getExpectedMethods("shell", "ShellAPI");
      expect(Object.keys(exposedAPIs.shellAPI).sort()).toEqual(expected);
    });

    it("preferencesAPI methods match PreferencesAPI", () => {
      const expected = getExpectedMethods("preferences", "PreferencesAPI");
      expect(Object.keys(exposedAPIs.preferencesAPI).sort()).toEqual(expected);
    });

    it("fileExportAPI methods match FileExportAPI", () => {
      const expected = getExpectedMethods("file", "FileExportAPI");
      expect(Object.keys(exposedAPIs.fileExportAPI).sort()).toEqual(expected);
    });

    it("gatewayAuthAPI methods match GatewayAuthAPI", () => {
      const expected = getExpectedMethods("gatewayAuth", "GatewayAuthAPI");
      expect(Object.keys(exposedAPIs.gatewayAuthAPI).sort()).toEqual(expected);
    });

    it("chatWindowsAPI methods match ChatWindowsAPI", () => {
      const expected = getExpectedMethods("chat-windows", "ChatWindowsAPI");
      expect(Object.keys(exposedAPIs.chatWindowsAPI).sort()).toEqual(expected);
    });

    it("contextPickerAPI methods match ContextPickerAPI", () => {
      const expected = getExpectedMethods("contextPicker", "ContextPickerAPI");
      expect(Object.keys(exposedAPIs.contextPickerAPI).sort()).toEqual(expected);
    });
  });

  // These only pass after `vite build` — skip when dist-electron doesn't exist (e.g. CI test step)
  const distExists = fs.existsSync(path.join(__dirname, "..", "dist-electron"));
  describe.skipIf(!distExists)("build output", () => {
    it("preload.cjs exists in dist-electron after vite build", () => {
      const preloadPath = path.join(__dirname, "..", "dist-electron", "preload.cjs");
      expect(fs.existsSync(preloadPath)).toBe(true);
    });

    it("preload.cjs in dist-electron matches source", () => {
      const source = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf-8");
      const built = fs.readFileSync(
        path.join(__dirname, "..", "dist-electron", "preload.cjs"),
        "utf-8",
      );
      expect(built).toBe(source);
    });

    it("mini-mode-preload.cjs exists in dist-electron after vite build", () => {
      const preloadPath = path.join(__dirname, "..", "dist-electron", "mini-mode-preload.cjs");
      expect(fs.existsSync(preloadPath)).toBe(true);
    });

    it("mini-mode-preload.cjs in dist-electron matches source", () => {
      const source = fs.readFileSync(path.join(__dirname, "mini-mode", "preload.cjs"), "utf-8");
      const built = fs.readFileSync(
        path.join(__dirname, "..", "dist-electron", "mini-mode-preload.cjs"),
        "utf-8",
      );
      expect(built).toBe(source);
    });
  });
});
