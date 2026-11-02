import type { RuntimeExtensionsAPI } from "@common/marshal-ipc-contract";
import { QueryClient } from "@tanstack/react-query";
import { act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { installMockAPIs, renderHook, waitFor } from "@/test-utils";

import { usePluginsActions } from "./usePluginsActions";

function setup() {
  installMockAPIs();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const setInstallingIds = vi.fn<(value: React.SetStateAction<Set<string>>) => void>();
  const { result } = renderHook(() =>
    usePluginsActions({
      queryClient,
      installedSkills: [],
      allMcpServers: [],
      setInstallingIds,
    }),
  );
  return result;
}

describe("usePluginsActions — handleAddMcp timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("converts seconds to milliseconds before invoking the IPC", async () => {
    const result = setup();

    act(() => {
      result.current.mcpFormProps.onNameChange("My Server");
      result.current.mcpFormProps.onUrlChange("http://localhost:3000");
      result.current.mcpFormProps.onTimeoutSecondsChange("30");
    });

    await act(async () => {
      await result.current.mcpFormProps.onAddMcpSave();
    });

    expect(window.mcpsAPI?.add).toHaveBeenCalledWith(expect.objectContaining({ timeout: 30_000 }));
  });

  it("omits timeout from the IPC payload when the field is empty", async () => {
    const result = setup();

    act(() => {
      result.current.mcpFormProps.onNameChange("My Server");
      result.current.mcpFormProps.onUrlChange("http://localhost:3000");
      // timeoutSeconds left as ""
    });

    await act(async () => {
      await result.current.mcpFormProps.onAddMcpSave();
    });

    expect(window.mcpsAPI?.add).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: undefined }),
    );
  });

  it.each([
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-5"],
    ["fractional", "1.5"],
  ])("throws (does not invoke IPC) on invalid timeout (%s)", async (_label, badInput) => {
    const result = setup();

    act(() => {
      result.current.mcpFormProps.onNameChange("My Server");
      result.current.mcpFormProps.onUrlChange("http://localhost:3000");
      result.current.mcpFormProps.onTimeoutSecondsChange(badInput);
    });

    await expect(
      act(async () => {
        await result.current.mcpFormProps.onAddMcpSave();
      }),
    ).rejects.toThrow(/positive whole number/i);

    expect(window.mcpsAPI?.add).not.toHaveBeenCalled();
  });

  it("rejects a timeout that would overflow safe-integer range when multiplied by 1000", async () => {
    const result = setup();
    const overflow = String(Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1);

    act(() => {
      result.current.mcpFormProps.onNameChange("My Server");
      result.current.mcpFormProps.onUrlChange("http://localhost:3000");
      result.current.mcpFormProps.onTimeoutSecondsChange(overflow);
    });

    await expect(
      act(async () => {
        await result.current.mcpFormProps.onAddMcpSave();
      }),
    ).rejects.toThrow(/positive whole number/i);

    expect(window.mcpsAPI?.add).not.toHaveBeenCalled();
  });

  it("passes envFile through for command-mode server add", async () => {
    const result = setup();

    act(() => {
      result.current.mcpFormProps.onNameChange("My Server");
      result.current.mcpFormProps.onModeChange("command");
      result.current.mcpFormProps.onCommandChange("npx -y my-server");
      result.current.mcpFormProps.onEnvFileChange("/path/.env");
    });

    await act(async () => {
      await result.current.mcpFormProps.onAddMcpSave();
    });

    expect(window.mcpsAPI?.add).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "command",
        command: "npx -y my-server",
        envFile: "/path/.env",
      }),
    );
  });
});

describe("usePluginsActions Runtime extensions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("installs a detected package root and invalidates catalog and status data", async () => {
    const packageRoot = "C:\\runtime-extensions\\unbuilt";
    const installLocal = vi.fn<RuntimeExtensionsAPI["installLocal"]>().mockResolvedValue({
      success: true,
      value: {
        identity: "@fixture/unbuilt",
        version: "1.0.0",
        integrity: {
          algorithm: "sha256",
          domain: "marshal-runtime-extension-package-v1",
          value: "a".repeat(64),
        },
        entrypoint: "dist/index.cjs",
        status: "enabled",
        activationOrder: 1,
        configuration: {},
      },
    });
    installMockAPIs({ runtimeExtensionsAPI: { installLocal } });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() =>
      usePluginsActions({
        queryClient,
        installedSkills: [],
        allMcpServers: [],
        setInstallingIds: vi.fn<(value: React.SetStateAction<Set<string>>) => void>(),
        runtimeScope: { sessionId: "session-1", workspaceName: "workspace-1" },
      }),
    );

    act(() => {
      result.current.handleRuntimeInstallDetected(packageRoot);
    });

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["runtime-extensions", "status"],
      });
    });
    expect(installLocal).toHaveBeenCalledWith({
      sessionId: "session-1",
      workspaceName: "workspace-1",
      packageRoot,
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["runtime-extensions", "catalog"],
    });
  });
});
