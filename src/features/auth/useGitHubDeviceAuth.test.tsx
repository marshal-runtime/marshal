import { describe, it, expect, beforeEach, vi } from "vitest";

import { installMockAPIs, renderHook, waitFor, act } from "@/test-utils";

import { useGitHubAuth } from "./useGitHubDeviceAuth";

beforeEach(() => {
  installMockAPIs();
});

describe("useGitHubAuth", () => {
  it("starts in 'checking' and resolves to 'signed-out' when no auth", async () => {
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: false,
    });

    const { result } = renderHook(() => useGitHubAuth());

    expect(result.current.status).toBe("checking");
    await waitFor(() => expect(result.current.status).toBe("signed-out"));
  });

  it("resolves to 'signed-in' when auth + models present", async () => {
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: true,
      login: "jane",
    });
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    });

    const { result } = renderHook(() => useGitHubAuth());

    await waitFor(() => expect(result.current.status).toBe("signed-in"));
    expect(result.current.login).toBe("jane");
  });

  it("resolves to 'copilot-access-error' when auth ok but no models", async () => {
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: true,
      login: "baduser",
    });
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [],
    });

    const { result } = renderHook(() => useGitHubAuth());

    await waitFor(() => expect(result.current.status).toBe("copilot-access-error"));
    expect(result.current.login).toBe("baduser");
  });

  it("resolves to 'copilot-access-error' when modelsAPI.list rejects", async () => {
    // Guards the catch branch in the probe queryFn. If a future refactor
    // broadens the try-block or drops the catch, signed-in-without-copilot
    // users would silently fall through to signed-in and the
    // CopilotAccessRequiredCard recovery path would never render.
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: true,
      login: "baduser",
    });
    vi.mocked(window.modelsAPI.list).mockRejectedValue(new Error("IPC timeout"));

    const { result } = renderHook(() => useGitHubAuth());

    await waitFor(() => expect(result.current.status).toBe("copilot-access-error"));
    expect(result.current.login).toBe("baduser");
  });

  it("resolves to 'not-allowed-plan' when copilotPlan is non-enterprise", async () => {
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: true,
      login: "prouser",
      copilotPlan: "individual_pro",
    });
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    });

    const { result } = renderHook(() => useGitHubAuth());

    await waitFor(() => expect(result.current.status).toBe("not-allowed-plan"));
    expect(result.current.login).toBe("prouser");
    expect(result.current.copilotPlan).toBe("individual_pro");
  });

  it("stays 'signed-in' when copilotPlan is 'enterprise'", async () => {
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: true,
      login: "entuser",
      copilotPlan: "enterprise",
    });
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    });

    const { result } = renderHook(() => useGitHubAuth());

    await waitFor(() => expect(result.current.status).toBe("signed-in"));
    expect(result.current.copilotPlan).toBe("enterprise");
  });

  it("stays 'signed-in' when copilotPlan is 'business'", async () => {
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: true,
      login: "bizuser",
      copilotPlan: "business",
    });
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    });

    const { result } = renderHook(() => useGitHubAuth());

    await waitFor(() => expect(result.current.status).toBe("signed-in"));
    expect(result.current.copilotPlan).toBe("business");
  });

  it("stays 'signed-in' when copilotPlan is undefined (probe could not verify)", async () => {
    // Defensive: a transient backend probe failure must not lock the user out.
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: true,
      login: "jane",
      // copilotPlan intentionally omitted
    });
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    });

    const { result } = renderHook(() => useGitHubAuth());

    await waitFor(() => expect(result.current.status).toBe("signed-in"));
  });

  it("startDeviceFlow returns device code and surfaces 'device-code' status", async () => {
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: false,
    });
    vi.mocked(window.copilotAPI.startDeviceFlow).mockResolvedValue({
      success: true,
      needsDeviceFlow: true,
      deviceCode: "ABCD-1234",
    });

    const { result } = renderHook(() => useGitHubAuth());
    await waitFor(() => expect(result.current.status).toBe("signed-out"));

    await act(async () => {
      await result.current.actions.startDeviceFlow();
    });

    expect(result.current.status).toBe("device-code");
    expect(result.current.deviceCode).toBe("ABCD-1234");
  });

  it("transitions from 'device-code' to 'signed-in' once auth polling catches up", async () => {
    // Regression test for the stuck-on-device-code bug: after the user pastes
    // the code and completes sign-in on github.com, the device-flow poll
    // returns isAuthenticated=true. The hook must then clear the device code
    // and report 'signed-in' — not stay parked on 'device-code'.
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: false,
    });
    vi.mocked(window.copilotAPI.startDeviceFlow).mockResolvedValue({
      success: true,
      needsDeviceFlow: true,
      deviceCode: "ABCD-1234",
    });

    const { result } = renderHook(() => useGitHubAuth());
    await waitFor(() => expect(result.current.status).toBe("signed-out"));

    await act(async () => {
      await result.current.actions.startDeviceFlow();
    });
    expect(result.current.status).toBe("device-code");

    // Simulate the CLI completing the login in the background.
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: true,
      login: "jane",
    });
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [{ id: "gpt-4o", name: "GPT-4o" }],
    });

    // Wait for the 2-second poll interval to fire + resolve. Once the probe
    // returns isAuthenticated, status must become "signed-in" — this is the
    // fix for the stuck-on-device-code bug. The `deviceCode` memory value can
    // remain; it gets overwritten on the next startDeviceFlow call.
    await waitFor(() => expect(result.current.status).toBe("signed-in"), { timeout: 5000 });
  });

  it("marks deviceCodeExpired after the timeout elapses with no auth signal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
        success: true,
        isAuthenticated: false,
      });
      vi.mocked(window.copilotAPI.startDeviceFlow).mockResolvedValue({
        success: true,
        needsDeviceFlow: true,
        deviceCode: "ABCD-1234",
      });

      const { result } = renderHook(() => useGitHubAuth());
      await waitFor(() => expect(result.current.status).toBe("signed-out"));

      await act(async () => {
        await result.current.actions.startDeviceFlow();
      });
      expect(result.current.status).toBe("device-code");
      expect(result.current.deviceCodeExpired).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2.5 * 60_000 + 100);
      });

      expect(result.current.deviceCodeExpired).toBe(true);
      expect(result.current.status).toBe("device-code");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flips deviceCodeExpired immediately when copilot:loginFailed fires", async () => {
    let triggerLoginFailed: ((reason: string) => void) | undefined;
    vi.mocked(window.copilotAPI.onLoginFailed).mockImplementation((cb) => {
      triggerLoginFailed = cb;
      return () => {};
    });
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: false,
    });
    vi.mocked(window.copilotAPI.startDeviceFlow).mockResolvedValue({
      success: true,
      needsDeviceFlow: true,
      deviceCode: "ABCD-1234",
    });

    const { result } = renderHook(() => useGitHubAuth());
    await waitFor(() => expect(result.current.status).toBe("signed-out"));

    await act(async () => {
      await result.current.actions.startDeviceFlow();
    });
    expect(result.current.deviceCodeExpired).toBe(false);

    act(() => {
      triggerLoginFailed?.("copilot login exited with code 1");
    });

    expect(result.current.deviceCodeExpired).toBe(true);
  });

  it("clears deviceCodeExpired when a new device flow starts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
        success: true,
        isAuthenticated: false,
      });
      vi.mocked(window.copilotAPI.startDeviceFlow).mockResolvedValue({
        success: true,
        needsDeviceFlow: true,
        deviceCode: "ABCD-1234",
      });

      const { result } = renderHook(() => useGitHubAuth());
      await waitFor(() => expect(result.current.status).toBe("signed-out"));

      await act(async () => {
        await result.current.actions.startDeviceFlow();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2.5 * 60_000 + 100);
      });
      expect(result.current.deviceCodeExpired).toBe(true);

      vi.mocked(window.copilotAPI.startDeviceFlow).mockResolvedValue({
        success: true,
        needsDeviceFlow: true,
        deviceCode: "WXYZ-5678",
      });
      await act(async () => {
        await result.current.actions.startDeviceFlow();
      });

      expect(result.current.deviceCode).toBe("WXYZ-5678");
      expect(result.current.deviceCodeExpired).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("signOut invalidates cache back to 'signed-out'", async () => {
    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: true,
      login: "jane",
    });
    const { result } = renderHook(() => useGitHubAuth());
    await waitFor(() => expect(result.current.status).toBe("signed-in"));

    vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
      success: true,
      isAuthenticated: false,
    });

    await act(async () => {
      await result.current.actions.signOut();
    });

    await waitFor(() => expect(result.current.status).toBe("signed-out"));
  });
});
