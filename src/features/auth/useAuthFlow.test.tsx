import { describe, it, expect, beforeEach, vi } from "vitest";

import { act, installMockAPIs, renderHook, waitFor } from "@/test-utils";

import { useAuthFlow } from "./useAuthFlow";

beforeEach(() => {
  installMockAPIs();
});

describe("useAuthFlow", () => {
  it("stage='checking' while runtime auth is loading", () => {
    vi.mocked(window.copilotAPI.checkAuth).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useAuthFlow());

    expect(result.current.stage.kind).toBe("checking");
  });

  it("stage='start' when runtime auth is signed out", async () => {
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: false,
    });

    const { result } = renderHook(() => useAuthFlow());

    await waitFor(() => expect(result.current.stage.kind).toBe("start"));
  });

  it("is ready when Copilot auth is valid", async () => {
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: true,
      login: "jane",
    });
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    });

    const { result } = renderHook(() => useAuthFlow());

    await waitFor(() => expect(result.current.stage.kind).toBe("ready"));
  });

  it("signOutAll signs out of the runtime", async () => {
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: true,
      login: "jane",
    });
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    });

    const { result } = renderHook(() => useAuthFlow());
    await waitFor(() => expect(result.current.stage.kind).toBe("ready"));

    await act(async () => {
      await result.current.actions.signOutAll();
    });

    expect(window.copilotAPI.signOut).toHaveBeenCalledOnce();
  });
});
