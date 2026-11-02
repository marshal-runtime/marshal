import { describe, expect, it, vi } from "vitest";

import type { MSettings } from "../../../common/marshal-ipc-contract";
import { CopilotPermissionsBackend } from "./permissions";

interface StubSettingsManager {
  get: () => MSettings;
  update: (patch: Partial<MSettings>) => void;
}

function makeStub(initial: MSettings): StubSettingsManager {
  let settings = initial;
  return {
    get: () => settings,
    update: (patch) => {
      settings = { ...settings, ...patch };
    },
  };
}

/** Minimal MSettings satisfying the type without populating every optional field. */
function makeStubSettings(overrides: Partial<MSettings> = {}): MSettings {
  return {
    autoApprove: { global: false, perServer: {} },
    ...overrides,
  };
}

describe("CopilotPermissionsBackend — cold-start (no setSettingsManager)", () => {
  it("getPermissions throws with a clear message when SettingsManager not wired", async () => {
    const backend = new CopilotPermissionsBackend();
    await expect(backend.getPermissions()).rejects.toThrow(/SettingsManager not wired/i);
  });

  it("updatePermissions throws with a clear message when SettingsManager not wired", async () => {
    const backend = new CopilotPermissionsBackend();
    await expect(backend.updatePermissions({})).rejects.toThrow(/SettingsManager not wired/i);
  });
});

describe("CopilotPermissionsBackend.getPermissions", () => {
  it("returns the global settings permissions field", async () => {
    const sm = makeStub(
      makeStubSettings({
        permissions: {
          autoApproveReadOnly: true,
          allow: [],
          tools: { foo: true },
          servers: {},
        },
      }),
    );
    const backend = new CopilotPermissionsBackend();
    backend.setSettingsManager(sm);

    const env = await backend.getPermissions();
    expect(env.supported).toBe(true);
    expect(env.permissions.autoApproveReadOnly).toBe(true);
    expect(env.permissions.tools).toEqual({ foo: true });
    expect(env.controllable).toEqual({
      tools: { enabled: true },
      autopilotMode: { enabled: true },
      autoApproveReadOnly: { enabled: true },
      shellAllow: { enabled: true },
      shellDeny: { enabled: true },
      serverEnabled: { enabled: true },
      serverAutoApprove: { enabled: true },
      perHeartbeatScope: { enabled: true },
    });
  });

  it("returns DEFAULT_PERMISSIONS shape when settings.permissions is absent", async () => {
    const sm = makeStub(makeStubSettings());
    const backend = new CopilotPermissionsBackend();
    backend.setSettingsManager(sm);

    const env = await backend.getPermissions();
    expect(env.permissions.autoApproveReadOnly).toBe(false);
    expect(typeof env.permissions.tools).toBe("object");
    expect(Object.keys(env.permissions.tools).length).toBeGreaterThan(0);
  });
});

describe("CopilotPermissionsBackend.updatePermissions", () => {
  it("merges the patch into existing permissions and saves", async () => {
    const sm = makeStub(
      makeStubSettings({
        permissions: {
          autoApproveReadOnly: false,
          allow: [],
          tools: { foo: true },
          servers: {},
        },
      }),
    );
    const updateSpy = vi.spyOn(sm, "update");
    const backend = new CopilotPermissionsBackend();
    backend.setSettingsManager(sm);

    const result = await backend.updatePermissions({ autoApproveReadOnly: true });
    expect(result).toEqual({ ok: true });
    expect(updateSpy).toHaveBeenCalledWith({
      permissions: expect.objectContaining({ autoApproveReadOnly: true, tools: { foo: true } }),
    });
  });

  it("starts from DEFAULT_PERMISSIONS when no current permissions", async () => {
    const sm = makeStub(makeStubSettings());
    const updateSpy = vi.spyOn(sm, "update");
    const backend = new CopilotPermissionsBackend();
    backend.setSettingsManager(sm);

    await backend.updatePermissions({ tools: { foo: true } });
    expect(updateSpy).toHaveBeenCalledWith({
      permissions: expect.objectContaining({
        tools: expect.objectContaining({ foo: true }),
        autoApproveReadOnly: false,
      }),
    });
  });
});
