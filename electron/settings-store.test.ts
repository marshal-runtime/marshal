import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted — use vi.hoisted() so variables are available inside them.
const {
  mockEncryptString,
  mockDecryptString,
  mockIsEncryptionAvailable,
  mockWriteFile,
  mockMkdir,
} = vi.hoisted(() => ({
  mockEncryptString: vi.fn<(s: string) => Buffer>((s: string) => Buffer.from(`enc:${s}`)),
  mockDecryptString: vi.fn<(b: Buffer) => string>((b: Buffer) => b.toString().replace(/^enc:/, "")),
  mockIsEncryptionAvailable: vi.fn<() => boolean>(() => true),
  mockWriteFile: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  mockMkdir: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn<() => boolean>(() => false),
    mkdirSync: vi.fn<() => void>(),
    readFileSync: vi.fn<() => string>(),
    writeFileSync: vi.fn<() => void>(),
    promises: {
      mkdir: mockMkdir,
      writeFile: mockWriteFile,
    },
  },
  existsSync: vi.fn<() => boolean>(() => false),
  mkdirSync: vi.fn<() => void>(),
  readFileSync: vi.fn<() => string>(),
  writeFileSync: vi.fn<() => void>(),
  promises: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
  },
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: mockIsEncryptionAvailable,
    encryptString: mockEncryptString,
    decryptString: mockDecryptString,
  },
}));
vi.mock("./app-paths", () => ({
  getAppDataDir: () => "/home/user/.marshal",
}));

import * as fs from "fs";

import type { MSettings, WhatsAppSettings } from "../common/marshal-ipc-contract";
import { sanitizePermissions } from "./settings-store";
import { mockCallArg } from "./testing/harness";

const mockedFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  mockIsEncryptionAvailable.mockReturnValue(true);
  mockEncryptString.mockImplementation((s: string) => Buffer.from(`enc:${s}`));
  mockDecryptString.mockImplementation((b: Buffer) => b.toString().replace(/^enc:/, ""));
  (mockedFs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
});

describe("saveSettingsToDisk / loadSettingsFromDisk", () => {
  it("persists WhatsApp preferences without QR, account JID, or secret fields", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");
    const settings: MSettings & {
      whatsapp: WhatsAppSettings & {
        qr: string;
        accountJid: string;
        secret: string;
      };
    } = {
      autoApprove: { global: false, perServer: {} },
      whatsapp: {
        enabled: true,
        defaultNotificationsEnabled: false,
        progressNotificationsEnabled: true,
        qr: "ephemeral-qr",
        accountJid: "15551234567@s.whatsapp.net",
        secret: "never-persist",
      },
    };

    saveSettings(settings);
    await flushSettingsWrite();

    const serialized = mockCallArg<string>(mockWriteFile, 0, 1);
    const written = JSON.parse(serialized);
    expect(written.whatsapp).toEqual({
      enabled: true,
      defaultNotificationsEnabled: false,
      progressNotificationsEnabled: true,
    });
    expect(serialized).not.toContain("ephemeral-qr");
    expect(serialized).not.toContain("@s.whatsapp.net");
    expect(serialized).not.toContain("never-persist");
  });

  it("preserves the device-local worktree directory through save/load", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");
    saveSettings({
      autoApprove: { global: false, perServer: {} },
      worktreeDir: "Q:/Marshal/worktrees",
    });

    await flushSettingsWrite();

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.worktreeDir).toBe("Q:/Marshal/worktrees");
  });

  it("preserves interceptFileChooser through save/load", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");
    saveSettings({
      autoApprove: { global: false, perServer: {} },
      interceptFileChooser: true,
    });

    await flushSettingsWrite();

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.interceptFileChooser).toBe(true);
  });

  it("preserves mouseWiggleEnabled through save/load", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");

    saveSettings({
      autoApprove: { global: false, perServer: {} },
      mouseWiggleEnabled: false,
    });

    await flushSettingsWrite();

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.mouseWiggleEnabled).toBe(false);
  });

  it("preserves preventSleepEnabled through save/load", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");

    saveSettings({
      autoApprove: { global: false, perServer: {} },
      preventSleepEnabled: false,
    });

    await flushSettingsWrite();

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.preventSleepEnabled).toBe(false);
  });

  it("loads mouseWiggleEnabled from disk", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        autoApprove: { global: false, perServer: {} },
        mouseWiggleEnabled: false,
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    expect(settings.mouseWiggleEnabled).toBe(false);
  });

  it("loads preventSleepEnabled from disk", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        autoApprove: { global: false, perServer: {} },
        preventSleepEnabled: false,
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    expect(settings.preventSleepEnabled).toBe(false);
  });

  it.each([true, false])(
    "ignores the legacy eulaAccepted=%s setting without affecting other preferences",
    async (eulaAccepted) => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          autoApprove: { global: false, perServer: {} },
          eulaAccepted,
          theme: "dark",
        }),
      );

      const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
      const settings = loadSettings();

      expect(settings).not.toHaveProperty("eulaAccepted");
      expect(settings.theme).toBe("dark");
    },
  );

  it("preserves runtime selection and notification provider through save/load", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");

    saveSettings({
      autoApprove: { global: false, perServer: {} },
      runtimeId: "gateway",
      notificationProviderId: "none",
      experiments: { uiExtensionsSystem: true },
    });

    await flushSettingsWrite();

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.runtimeId).toBe("gateway");
    expect(written.notificationProviderId).toBe("none");
    expect(written.experiments.uiExtensionsSystem).toBe(true);

    // And confirm the load path doesn't strip them either.
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(written));
    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();
    expect(settings.runtimeId).toBe("gateway");
    expect(settings.notificationProviderId).toBe("none");
    expect(settings.experiments?.uiExtensionsSystem).toBe(true);
  });

  it("migrates a missing notification provider ID to the explicit default", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        autoApprove: { global: false, perServer: {} },
        runtimeId: "copilot",
        cloudProviderId: "legacy-cloud",
      }),
    );

    const { loadSettingsFromDisk: loadSettings, flushSettingsWrite } =
      await import("./settings-store");
    const settings = loadSettings();
    await flushSettingsWrite();

    expect(settings.notificationProviderId).toBe("marshal-relay");
    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.notificationProviderId).toBe("marshal-relay");
    expect(written).not.toHaveProperty("cloudProviderId");
  });

  it("round-trips concurrent relay providers and provider-ID destinations", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");
    saveSettings({
      autoApprove: { global: false, perServer: {} },
      relay: {
        providers: {
          signal: {
            enabled: true,
            accountId: "signal-account-1",
            connectionIntent: "connect",
          },
          whatsapp: {
            enabled: true,
            accountId: "whatsapp-account-1",
            connectionIntent: "disconnect",
          },
        },
        defaultNotificationDestinations: ["signal", "whatsapp"],
        progressDestinations: ["whatsapp"],
        progressIntervalMinutes: 30,
      },
    });

    await flushSettingsWrite();

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.relay).toEqual({
      providers: {
        signal: {
          enabled: true,
          accountId: "signal-account-1",
          connectionIntent: "connect",
        },
        whatsapp: {
          enabled: true,
          accountId: "whatsapp-account-1",
          connectionIntent: "disconnect",
        },
      },
      defaultNotificationDestinations: ["signal", "whatsapp"],
      progressDestinations: ["whatsapp"],
      progressIntervalMinutes: 30,
    });
    expect(written).not.toHaveProperty("teamsRelayConnected");
    expect(written).not.toHaveProperty("teamsAgentNotificationsEnabled");
    expect(written).not.toHaveProperty("teamsProgressNotificationsEnabled");

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(written));
    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    expect(loadSettings().relay).toEqual(written.relay);
  });

  it("drops legacy Teams relay wire fields on load", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        teamsRelayConnected: true,
        teamsNotify: "always",
        teamsProgressNotificationsEnabled: false,
        teamsProgressNotificationIntervalSeconds: 60,
      }),
    );

    const { flushSettingsWrite, loadSettingsFromDisk: loadSettings } =
      await import("./settings-store");
    const settings = loadSettings();
    await flushSettingsWrite();

    expect(settings.relay).toEqual({
      providers: {
        whatsapp: {
          enabled: true,
          connectionIntent: "disconnect",
        },
      },
      defaultNotificationDestinations: [],
      progressDestinations: ["whatsapp"],
      progressIntervalMinutes: 15,
    });

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written).not.toHaveProperty("teamsNotify");
    expect(written).not.toHaveProperty("teamsRelayConnected");
    expect(written).not.toHaveProperty("teamsProgressNotificationsEnabled");
    expect(written).not.toHaveProperty("teamsProgressNotificationIntervalSeconds");
    expect(written.relay).toEqual(settings.relay);
  });

  it("migrates legacy WhatsApp connection intent into the canonical relay provider", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        whatsapp: {
          enabled: true,
          defaultNotificationsEnabled: true,
          progressNotificationsEnabled: true,
        },
      }),
    );

    const { flushSettingsWrite, loadSettingsFromDisk: loadSettings } =
      await import("./settings-store");
    const settings = loadSettings();
    await flushSettingsWrite();

    expect(settings.relay?.providers.whatsapp).toEqual({
      enabled: true,
      accountId: "primary",
      connectionIntent: "connect",
    });
    expect(settings.relay?.defaultNotificationDestinations).toContain("whatsapp");
    expect(settings.relay?.progressDestinations).toContain("whatsapp");
  });

  it("preserves canonical WhatsApp notification opt-outs across restart", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        relay: {
          providers: {
            whatsapp: {
              enabled: true,
              accountId: "primary",
              connectionIntent: "connect",
            },
          },
          defaultNotificationDestinations: [],
          progressDestinations: [],
          progressIntervalMinutes: 15,
        },
        whatsapp: {
          enabled: true,
          defaultNotificationsEnabled: true,
          progressNotificationsEnabled: true,
        },
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    expect(settings.relay?.defaultNotificationDestinations).toEqual([]);
    expect(settings.relay?.progressDestinations).toEqual([]);
  });

  it("drops legacy Teams notification flags without affecting canonical relay settings", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        teamsNotify: "always",
        teamsAgentNotificationsEnabled: false,
        teamsProgressNotificationsEnabled: true,
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    expect(settings.relay?.defaultNotificationDestinations).toEqual([]);
    expect(settings.relay?.progressDestinations).toEqual(["whatsapp"]);
    expect(settings).not.toHaveProperty("teamsAgentNotificationsEnabled");
    expect(settings).not.toHaveProperty("teamsProgressNotificationsEnabled");
  });

  it("does not re-derive legacy Teams wire fields from canonical relay settings", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        relay: {
          providers: {
            whatsapp: {
              enabled: true,
              accountId: "primary",
              connectionIntent: "connect",
            },
          },
          defaultNotificationDestinations: [],
          progressDestinations: ["whatsapp"],
        },
      }),
    );

    const { flushSettingsWrite, loadSettingsFromDisk: loadSettings } =
      await import("./settings-store");
    const settings = loadSettings();
    await flushSettingsWrite();

    expect(settings).not.toHaveProperty("teamsRelayConnected");
    expect(settings).not.toHaveProperty("teamsAgentNotificationsEnabled");
    expect(settings).not.toHaveProperty("teamsProgressNotificationsEnabled");
    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written).not.toHaveProperty("teamsRelayConnected");
    expect(written).not.toHaveProperty("teamsAgentNotificationsEnabled");
    expect(written).not.toHaveProperty("teamsProgressNotificationsEnabled");
  });

  it("strips credentials, provider addresses, routing state, and receipts from relay settings", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        relay: {
          providers: {
            signal: {
              enabled: true,
              accountId: "signal-account-3",
              connectionIntent: "connect",
              credentials: { accessToken: "signal-secret" },
              conversationId: "19:raw-thread@thread.v2",
              bindings: [{ sessionId: "session-1" }],
              receipts: [{ id: "receipt-1" }],
            },
            whatsapp: {
              enabled: true,
              accountId: "15551234567@s.whatsapp.net",
              connectionIntent: "connect",
              jid: "120363000000000000@g.us",
              authState: { key: "whatsapp-secret" },
              dedupeRows: [{ id: "message-1" }],
            },
          },
          defaultNotificationDestinations: ["signal", "whatsapp", "19:raw-thread@thread.v2"],
          progressDestinations: ["whatsapp", "120363000000000000@g.us"],
          bindings: [{ providerId: "signal" }],
          receipts: [{ id: "receipt-2" }],
        },
        credentials: { token: "top-level-secret" },
      }),
    );

    const { flushSettingsWrite, loadSettingsFromDisk: loadSettings } =
      await import("./settings-store");
    const settings = loadSettings();
    await flushSettingsWrite();

    expect(settings.relay).toEqual({
      providers: {
        signal: {
          enabled: true,
          accountId: "signal-account-3",
          connectionIntent: "connect",
        },
        whatsapp: {
          enabled: true,
          connectionIntent: "connect",
        },
      },
      defaultNotificationDestinations: ["signal", "whatsapp"],
      progressDestinations: ["whatsapp"],
      progressIntervalMinutes: 15,
    });

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    const serialized = JSON.stringify(written);
    expect(serialized).not.toContain("signal-secret");
    expect(serialized).not.toContain("whatsapp-secret");
    expect(serialized).not.toContain("top-level-secret");
    expect(serialized).not.toContain("19:raw-thread@thread.v2");
    expect(serialized).not.toContain("120363000000000000@g.us");
    expect(serialized).not.toContain("bindings");
    expect(serialized).not.toContain("dedupeRows");
    expect(serialized).not.toContain("receipts");
  });

  it("sanitizes relay settings on direct saves", async () => {
    const providerWithSecrets = {
      enabled: true,
      accountId: "signal-account-4",
      connectionIntent: "connect" as const,
      credentials: { accessToken: "direct-save-secret" },
      conversationId: "19:direct-save@thread.v2",
      bindings: [{ id: "binding-1" }],
    };
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");
    saveSettings({
      autoApprove: { global: false, perServer: {} },
      relay: {
        providers: { signal: providerWithSecrets },
        defaultNotificationDestinations: ["signal"],
        progressDestinations: ["signal"],
        progressIntervalMinutes: 15,
      },
    });

    await flushSettingsWrite();

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.relay.providers.signal).toEqual({
      enabled: true,
      accountId: "signal-account-4",
      connectionIntent: "connect",
    });
    expect(JSON.stringify(written)).not.toContain("direct-save-secret");
    expect(JSON.stringify(written)).not.toContain("19:direct-save@thread.v2");
    expect(JSON.stringify(written)).not.toContain("bindings");
  });

  it("preserves an open-ended local runtime adapter ID", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");

    saveSettings({
      autoApprove: { global: false, perServer: {} },
      runtimeId: "codex",
    });
    await flushSettingsWrite();

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.runtimeId).toBe("codex");

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(written));
    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    expect(loadSettings().runtimeId).toBe("codex");
  });

  it("preserves experiments.titleBarNavigation through save/load", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");

    saveSettings({
      autoApprove: { global: false, perServer: {} },
      experiments: { titleBarNavigation: true },
    });

    await flushSettingsWrite();

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.experiments.titleBarNavigation).toBe(true);

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(written));
    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();
    expect(settings.experiments?.titleBarNavigation).toBe(true);
  });

  it("preserves the lean experiment flags through save/load and defaults each ON when absent", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");

    saveSettings({
      autoApprove: { global: false, perServer: {} },
      experiments: { leanPrompt: false, leanRepoRules: false, leanCore: false },
    });

    await flushSettingsWrite();

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.experiments).toMatchObject({
      leanPrompt: false,
      leanRepoRules: false,
      leanCore: false,
    });

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(written));
    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    expect(loadSettings().experiments).toMatchObject({
      leanPrompt: false,
      leanRepoRules: false,
      leanCore: false,
    });

    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ autoApprove: { global: false, perServer: {} }, experiments: {} }),
    );
    expect(loadSettings().experiments).toMatchObject({
      leanPrompt: true,
      leanRepoRules: true,
      leanCore: true,
    });
  });

  it("preserves permissions.allowedSensitivePaths through save/load", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");
    saveSettings({
      autoApprove: { global: false, perServer: {} },
      permissions: {
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: {},
        allowedSensitivePaths: ["/home/user/.ssh/config", "/home/user/.gitconfig"],
      },
    });
    await flushSettingsWrite();
    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.permissions.allowedSensitivePaths).toEqual([
      "/home/user/.ssh/config",
      "/home/user/.gitconfig",
    ]);

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(written));
    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();
    expect(settings.permissions?.allowedSensitivePaths).toEqual([
      "/home/user/.ssh/config",
      "/home/user/.gitconfig",
    ]);
  });

  it("preserves permissions.denyPatterns through save/load", async () => {
    // Pin the round-trip — sanitizePermissions has historically been the
    // place where new PermissionsConfig fields silently disappear.
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");
    saveSettings({
      autoApprove: { global: false, perServer: {} },
      permissions: {
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: {},
        denyPatterns: ["shell:rm -rf /", "shell:dd if=*"],
      },
    });
    await flushSettingsWrite();
    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.permissions.denyPatterns).toEqual(["shell:rm -rf /", "shell:dd if=*"]);

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(written));
    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();
    expect(settings.permissions?.denyPatterns).toEqual(["shell:rm -rf /", "shell:dd if=*"]);
  });

  it("preserves permissions.autopilotMode through save/load", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");
    saveSettings({
      autoApprove: { global: false, perServer: {} },
      permissions: {
        autopilotMode: true,
        autoApproveReadOnly: false,
        allow: [],
        tools: {},
        servers: {},
      },
    });
    await flushSettingsWrite();
    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.permissions.autopilotMode).toBe(true);

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(written));
    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();
    expect(settings.permissions?.autopilotMode).toBe(true);
  });

  it("preserves updateChannelBeta=true through save round-trip", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");

    saveSettings({
      autoApprove: { global: false, perServer: {} },
      updateChannelBeta: true,
    });

    await flushSettingsWrite();

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.updateChannelBeta).toBe(true);
  });

  it("preserves showHideShortcut through save/load round-trip", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");

    saveSettings({
      autoApprove: { global: false, perServer: {} },
      showHideShortcut: "CommandOrControl+Shift+K",
    });

    await flushSettingsWrite();

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.showHideShortcut).toBe("CommandOrControl+Shift+K");

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(written));
    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();
    expect(settings.showHideShortcut).toBe("CommandOrControl+Shift+K");
  });

  it("preserves updateChannelBeta=false through save round-trip", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");

    saveSettings({
      autoApprove: { global: false, perServer: {} },
      updateChannelBeta: false,
    });

    await flushSettingsWrite();

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.updateChannelBeta).toBe(false);
  });

  it("loads updateChannelBeta from disk", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        autoApprove: { global: false, perServer: {} },
        updateChannelBeta: true,
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();
    expect(settings.updateChannelBeta).toBe(true);
  });

  it("preserves runtimeId through save/load round-trip", async () => {
    const { saveSettingsToDisk: saveSettings, flushSettingsWrite } =
      await import("./settings-store");

    saveSettings({
      autoApprove: { global: false, perServer: {} },
      runtimeId: "gateway",
    });

    await flushSettingsWrite();

    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.runtimeId).toBe("gateway");
  });

  it("migrates memoraEnabled one-way to the local memory provider and removes the legacy flag", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ experiments: { memoraEnabled: true, uiExtensionsSystem: true } }),
    );

    const { flushSettingsWrite, loadSettingsFromDisk: loadSettings } =
      await import("./settings-store");
    const settings = loadSettings();
    await flushSettingsWrite();

    expect(settings.memoryProviderId).toBe("@marshal/brain");
    expect(settings.sessionStorageProviderId).toBe("local");
    expect(settings.skillProviderIds).toEqual([
      "runtime-adapter",
      "workspace-local",
      "user-global",
      "app-bundled",
    ]);
    expect(settings.experiments?.uiExtensionsSystem).toBe(true);
    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.experiments).not.toHaveProperty("memoraEnabled");
  });

  it("keeps explicit provider IDs over the legacy Memora flag", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        memoryProviderId: "local",
        sessionStorageProviderId: "local",
        skillProviderIds: ["app-bundled"],
        experiments: { memoraEnabled: true },
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    expect(settings.memoryProviderId).toBe("local");
    expect(settings.sessionStorageProviderId).toBe("local");
    expect(settings.skillProviderIds).toEqual(["app-bundled"]);
  });

  it.each(["memora", "memora-shadow"])(
    "migrates the removed %s provider selection one-way to local",
    async (memoryProviderId) => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ memoryProviderId }));

      const { flushSettingsWrite, loadSettingsFromDisk: loadSettings } =
        await import("./settings-store");
      const settings = loadSettings();
      await flushSettingsWrite();

      expect(settings.memoryProviderId).toBe("local");
      const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
      expect(written.memoryProviderId).toBe("local");
    },
  );

  it("removes the obsolete OneDrive memory provider selection", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        memoryProviderId: "onedrive",
        sessionStorageProviderId: "onedrive",
      }),
    );

    const { flushSettingsWrite, loadSettingsFromDisk: loadSettings } =
      await import("./settings-store");
    const settings = loadSettings();
    await flushSettingsWrite();

    expect(settings.memoryProviderId).toBe("@marshal/brain");
    expect(settings.sessionStorageProviderId).toBe("onedrive");
    const written = JSON.parse(mockCallArg<string>(mockWriteFile, 0, 1));
    expect(written.memoryProviderId).toBe("@marshal/brain");
  });

  it("deep-merges DEFAULT_SETTINGS experiments with disk experiments (fix: don't overwrite defaults)", async () => {
    // Regression: without the explicit `experiments: { ...DEFAULT_SETTINGS.experiments, ...known.experiments }`
    // line in loadSettingsFromDisk, spreading `...known` would completely replace DEFAULT_SETTINGS.experiments
    // with the partial disk object, dropping any defaults present in DEFAULT_SETTINGS.
    const { DEFAULT_SETTINGS, loadSettingsFromDisk: loadSettings } =
      await import("./settings-store");

    // Inject a default experiment flag so there is something to lose if the merge is shallow
    const originalExperiments = DEFAULT_SETTINGS.experiments;
    DEFAULT_SETTINGS.experiments = { titleBarNavigation: false };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        // Disk only has uiExtensionsSystem — no titleBarNavigation flag
        experiments: { uiExtensionsSystem: true },
      }),
    );

    const settings = loadSettings();

    // Restore the default before any assertions can fail
    DEFAULT_SETTINGS.experiments = originalExperiments;

    // Disk value is preserved
    expect(settings.experiments?.uiExtensionsSystem).toBe(true);
    // DEFAULT_SETTINGS.experiments.titleBarNavigation default is NOT overwritten by the partial disk object
    expect(settings.experiments?.titleBarNavigation).toBe(false);
  });

  it("strips unknown fields inside experiments (Zod .strip())", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        autoApprove: { global: false, perServer: {} },
        experiments: { uiExtensionsSystem: true, unknownExperiment: "bad" },
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    expect(settings.experiments?.uiExtensionsSystem).toBe(true);
    expect(settings.experiments).not.toHaveProperty("unknownExperiment");
  });

  it("preserves provider-neutral swarm role policies loaded from disk", async () => {
    const swarmRoleModels = {
      planner: { model: "provider/planner", reasoningEffort: "max" },
      reviewer: { model: "provider/reviewer" },
      worker: { model: "provider/worker", reasoningEffort: "high" },
      reconciler: { model: "provider/reconciler", reasoningEffort: "max" },
    };
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ swarmRoleModels }));
    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    expect(loadSettings().swarmRoleModels).toEqual(swarmRoleModels);
  });

  it("drops unknown fields from disk data (Zod schema enforcement)", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        autoApprove: { global: true, perServer: {}, unknownNested: "bad" },
        theme: "dark",
        unknownField: "should-be-dropped",
        __proto__: { injected: true },
        anotherUnknown: 42,
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    // Known fields are preserved
    expect(settings.autoApprove.global).toBe(true);
    expect(settings.theme).toBe("dark");

    // Unknown top-level fields are dropped
    expect(settings).not.toHaveProperty("unknownField");
    expect(settings).not.toHaveProperty("anotherUnknown");
    expect(settings).not.toHaveProperty("__proto__.injected");

    // Unknown nested fields inside autoApprove are also dropped
    expect(settings.autoApprove).not.toHaveProperty("unknownNested");
  });
});

describe("loadSettingsFromDisk → migratePermissions integration", () => {
  it("migrates old-format file with no permissions key to new format", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        autoApprove: {
          global: false,
          perServer: { Shell: { shell: true } },
        },
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    // Should have permissions block populated from migration
    expect(settings.permissions).toBeDefined();
    expect(settings.permissions!.servers.shell.autoApprove).toBe(true);
    // Defaults preserved for untouched servers
    expect(settings.permissions!.servers.filesystem.autoApprove).toBe(false);
    expect(settings.permissions!.servers.playwright.autoApprove).toBe(false);
  });

  it("uses defaults when permissions block fails Zod validation", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        permissions: {
          autoApproveReadOnly: "yes", // Invalid type — Zod rejects entire block
          allow: ["npm run *"],
          servers: {},
        },
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    // Zod rejects the block → sanitizePermissions gets undefined → returns defaults
    expect(settings.permissions!.autoApproveReadOnly).toBe(false);
    expect(settings.permissions!.allow).toEqual([]);
  });

  it("preserves valid permissions block through Zod + sanitize pipeline", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        permissions: {
          autoApproveReadOnly: true,
          allow: ["npm run *", "cat *"],
          servers: {
            filesystem: { enabled: true, autoApprove: true },
          },
        },
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    expect(settings.permissions!.autoApproveReadOnly).toBe(true);
    expect(settings.permissions!.allow).toEqual(["npm run *", "cat *"]);
    expect(settings.permissions!.servers.filesystem.autoApprove).toBe(true);
  });

  it("migrates autoApproveAll: true to autoApproveReadOnly through full load pipeline", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        permissions: {
          autoApproveAll: true,
          autoApproveReadOnly: false,
          allow: [],
          tools: {},
          servers: {},
        },
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    expect(settings.permissions!.autoApproveReadOnly).toBe(true);
    expect(settings.permissions).not.toHaveProperty("autoApproveAll");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[Settings]"),
      expect.stringContaining("autoApproveAll has been removed"),
    );
    spy.mockRestore();
  });

  it("preserves previousTools through sanitize pipeline", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        permissions: {
          autoApproveReadOnly: false,
          allow: [],
          tools: { "tool:email": true },
          previousTools: {
            "tool:email": {
              "tool:email": false,
              "tool:listEmails": true,
              "tool:sendEmail": false,
            },
          },
          servers: {},
        },
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    // Snapshot entries survive even though tool keys aren't in current tools map
    // (after group ON, individual keys are removed from tools but must stay in snapshot)
    expect(settings.permissions!.previousTools).toEqual({
      "tool:email": {
        "tool:email": false,
        "tool:listEmails": true,
        "tool:sendEmail": false,
      },
    });
  });

  it("drops previousTools entries with non-boolean values via Zod schema", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        permissions: {
          autoApproveReadOnly: false,
          allow: [],
          tools: { "tool:email": true },
          previousTools: {
            "tool:email": {
              "tool:email": false,
              "tool:listEmails": "not-boolean",
              "tool:sendEmail": 42,
            },
          },
          servers: {},
        },
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    // Zod schema rejects non-boolean values in the inner record,
    // which causes the entire previousTools block to be dropped
    expect(settings.permissions!.previousTools).toEqual({});
  });

  it("previousTools snapshot survives sanitize after group toggle ON (round-trip)", async () => {
    // Simulate state after user had partial permissions (1/2) and toggled group ON:
    // - tools only has the group key (individual keys were deleted)
    // - previousTools has the original per-tool states
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        permissions: {
          autoApproveReadOnly: false,
          allow: [],
          tools: { "tool:email": true },
          previousTools: {
            "tool:email": {
              "tool:email": false,
              "tool:listEmails": true,
              "tool:sendEmail": false,
            },
          },
          servers: {},
        },
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    // The snapshot must survive even though tool:listEmails and
    // tool:sendEmail are NOT in the current tools map
    const snapshot = settings.permissions!.previousTools?.["tool:email"];
    expect(snapshot).toBeDefined();
    expect(snapshot!["tool:email"]).toBe(false);
    expect(snapshot!["tool:listEmails"]).toBe(true);
    expect(snapshot!["tool:sendEmail"]).toBe(false);
  });

  it("strips reserved permission kind names from servers config", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        permissions: {
          autoApproveReadOnly: false,
          allow: [],
          tools: {},
          servers: {
            filesystem: { enabled: true, autoApprove: false },
            write: { enabled: true, autoApprove: true },
            url: { enabled: true, autoApprove: true },
            read: { enabled: true, autoApprove: true },
            mcp: { enabled: true, autoApprove: true },
            "custom-tool": { enabled: true, autoApprove: true },
            "my-custom-server": { enabled: true, autoApprove: false },
          },
        },
      }),
    );

    const { loadSettingsFromDisk: loadSettings } = await import("./settings-store");
    const settings = loadSettings();

    // All reserved kind names should be stripped
    expect(settings.permissions!.servers).not.toHaveProperty("write");
    expect(settings.permissions!.servers).not.toHaveProperty("url");
    expect(settings.permissions!.servers).not.toHaveProperty("read");
    expect(settings.permissions!.servers).not.toHaveProperty("mcp");
    expect(settings.permissions!.servers).not.toHaveProperty("custom-tool");
    // Valid server keys should be preserved
    expect(settings.permissions!.servers).toHaveProperty("filesystem");
    expect(settings.permissions!.servers).toHaveProperty("my-custom-server");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[Settings]"),
      expect.stringContaining('Stripping reserved server key "write"'),
    );
    spy.mockRestore();
  });
});

describe("sanitizePermissions — scoped folder grants", () => {
  it("preserves allowedReadFolders and allowedWriteFolders string arrays", () => {
    const result = sanitizePermissions({
      allowedReadFolders: ["/Users/me/Downloads", 42, "/Users/me/Docs"],
      allowedWriteFolders: ["/Users/me/Exports"],
    });
    expect(result.allowedReadFolders).toEqual(["/Users/me/Downloads", "/Users/me/Docs"]);
    expect(result.allowedWriteFolders).toEqual(["/Users/me/Exports"]);
  });

  it("omits the fields when absent", () => {
    const result = sanitizePermissions({});
    expect(result.allowedReadFolders).toBeUndefined();
    expect(result.allowedWriteFolders).toBeUndefined();
  });
});

describe("sanitizePermissions — dead filesystem MCP tool keys", () => {
  it("prunes mcp:filesystem keys but keeps tool:read and servers.filesystem", () => {
    const result = sanitizePermissions({
      tools: {
        "mcp:filesystem": true,
        "mcp:filesystem:read_text_file": true,
        "tool:read": true,
        "mcp:playwright:browser_click": true,
      },
      servers: { filesystem: { enabled: true, autoApprove: true } },
    });
    expect(result.tools["mcp:filesystem"]).toBeUndefined();
    expect(result.tools["mcp:filesystem:read_text_file"]).toBeUndefined();
    expect(result.tools["tool:read"]).toBe(true);
    expect(result.tools["mcp:playwright:browser_click"]).toBe(true);
    expect(result.servers.filesystem).toEqual({ enabled: true, autoApprove: true });
  });

  it("prunes the dead mcp:filesystem group from previousTools snapshots", () => {
    const result = sanitizePermissions({
      tools: {},
      previousTools: {
        "mcp:filesystem": { "mcp:filesystem:read_file": true },
        "mcp:playwright": { "mcp:playwright:browser_click": true },
      },
    });
    const prev = result.previousTools ?? {};
    expect(prev["mcp:filesystem"]).toBeUndefined();
    expect(prev["mcp:playwright"]).toEqual({ "mcp:playwright:browser_click": true });
  });
});
