import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn<(message: string) => void>(),
    warning: vi.fn<(message: string) => void>(),
  },
}));

import { installMockAPIs } from "@/test-utils";

import { usePermissions } from "./usePermissionsConfig";

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { Wrapper, qc };
}

const SAMPLE_ENVELOPE = {
  supported: true,
  permissions: { autoApproveReadOnly: true, allow: [] as string[], tools: {}, servers: {} },
  controllable: {
    tools: { enabled: true },
    autopilotMode: { enabled: true },
    autoApproveReadOnly: { enabled: true },
    shellAllow: { enabled: true },
    shellDeny: {
      enabled: false,
      disabledReason: "Shell command deny patterns are not supported in gateway mode yet.",
    },
    serverEnabled: {
      enabled: false,
      disabledReason: "MCP server enable/disable is not supported in gateway mode yet.",
    },
    serverAutoApprove: {
      enabled: false,
      disabledReason: "Per-server auto-approve is not supported in gateway mode yet.",
    },
    perHeartbeatScope: {
      enabled: false,
      disabledReason: "Per-heartbeat overrides are not supported in gateway mode yet.",
    },
  },
};

beforeEach(() => {
  installMockAPIs();
  vi.clearAllMocks();
});

describe("usePermissions", () => {
  it("loads the envelope from permissions:get-config", async () => {
    vi.mocked(window.permissionsAPI!.getConfig).mockResolvedValue({
      success: true,
      envelope: SAMPLE_ENVELOPE,
    });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => usePermissions(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.envelope).toBeDefined());
    expect(result.current.envelope?.controllable.shellDeny.enabled).toBe(false);
  });

  it("error path: getConfig returns { success: false } → hook surfaces error", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: forcing error branch for the mock
    vi.mocked(window.permissionsAPI!.getConfig).mockResolvedValue({
      success: false,
      error: "boom",
    } as unknown as Awaited<ReturnType<NonNullable<typeof window.permissionsAPI>["getConfig"]>>);

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => usePermissions(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    // useQuery throws new Error(r.error) — the message comes from the error field
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: error is an Error thrown by queryFn
    expect((result.current.error as Error).message).toBe("boom");
  });

  it("save path: calls saveConfig with patch and updates envelope", async () => {
    vi.mocked(window.permissionsAPI!.getConfig).mockResolvedValue({
      success: true,
      envelope: SAMPLE_ENVELOPE,
    });
    vi.mocked(window.permissionsAPI!.saveConfig).mockResolvedValue({ success: true });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => usePermissions(), { wrapper: Wrapper });

    // Wait for initial load
    await waitFor(() => expect(result.current.envelope).toBeDefined());

    // Trigger save
    act(() => {
      result.current.save({ autoApproveReadOnly: false });
    });

    // saveConfig should have been called with the patch
    await waitFor(() => {
      expect(window.permissionsAPI!.saveConfig).toHaveBeenCalledWith({
        autoApproveReadOnly: false,
      });
    });
  });

  it("save path: optimistic update applies immediately before saveConfig resolves", async () => {
    vi.mocked(window.permissionsAPI!.getConfig).mockResolvedValue({
      success: true,
      envelope: {
        ...SAMPLE_ENVELOPE,
        permissions: { ...SAMPLE_ENVELOPE.permissions, autoApproveReadOnly: true },
      },
    });

    let resolvesSave!: (v: { success: true }) => void;
    vi.mocked(window.permissionsAPI!.saveConfig).mockImplementation(
      () =>
        new Promise<{ success: true }>((resolve) => {
          resolvesSave = resolve;
        }),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => usePermissions(), { wrapper: Wrapper });
    await waitFor(() =>
      expect(result.current.envelope?.permissions.autoApproveReadOnly).toBe(true),
    );

    // Trigger save — the optimistic update should flip the value immediately
    act(() => {
      result.current.save({ autoApproveReadOnly: false });
    });

    // Optimistic update should be visible before saveConfig resolves
    await waitFor(() =>
      expect(result.current.envelope?.permissions.autoApproveReadOnly).toBe(false),
    );

    // Now let the save resolve
    act(() => {
      resolvesSave({ success: true });
    });
  });

  it("save path: rolls back optimistic update on saveConfig error", async () => {
    vi.mocked(window.permissionsAPI!.getConfig).mockResolvedValue({
      success: true,
      envelope: {
        ...SAMPLE_ENVELOPE,
        permissions: { ...SAMPLE_ENVELOPE.permissions, autoApproveReadOnly: true },
      },
    });
    vi.mocked(window.permissionsAPI!.saveConfig).mockRejectedValue(new Error("network error"));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => usePermissions(), { wrapper: Wrapper });
    await waitFor(() =>
      expect(result.current.envelope?.permissions.autoApproveReadOnly).toBe(true),
    );

    // Trigger a save that will fail
    act(() => {
      result.current.save({ autoApproveReadOnly: false });
    });

    // After the error, the value should revert to original
    await waitFor(() =>
      expect(result.current.envelope?.permissions.autoApproveReadOnly).toBe(true),
    );
  });

  it("settings:changed event triggers query invalidation → re-fetches getConfig", async () => {
    let callCount = 0;
    vi.mocked(window.permissionsAPI!.getConfig).mockImplementation(async () => {
      callCount += 1;
      return { success: true, envelope: SAMPLE_ENVELOPE };
    });

    // Capture the onChanged listener registered by the hook
    let capturedOnChanged: (() => void) | null = null;
    vi.mocked(window.settingsAPI?.onChanged).mockImplementation((fn) => {
      capturedOnChanged = fn;
      return () => {};
    });

    const { Wrapper } = makeWrapper();
    renderHook(() => usePermissions(), { wrapper: Wrapper });

    // Wait for the initial fetch
    await waitFor(() => expect(callCount).toBe(1));

    // Fire the settings:changed listener
    act(() => {
      capturedOnChanged?.();
    });

    // Invalidation should trigger a re-fetch
    await waitFor(() => expect(callCount).toBe(2));
  });

  it("rejectedShellPatterns toast: saveConfig returns rejected patterns → toast.warning called", async () => {
    vi.mocked(window.permissionsAPI!.getConfig).mockResolvedValue({
      success: true,
      envelope: SAMPLE_ENVELOPE,
    });
    vi.mocked(window.permissionsAPI!.saveConfig).mockResolvedValue({
      success: true,
      rejectedShellPatterns: ["gh api repos/foo/*"],
    });

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => usePermissions(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.envelope).toBeDefined());

    act(() => {
      result.current.save({ allow: ["gh api repos/foo/*"] });
    });

    await waitFor(() => {
      expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
        expect.stringContaining("gh api repos/foo/*"),
      );
    });
  });
});
