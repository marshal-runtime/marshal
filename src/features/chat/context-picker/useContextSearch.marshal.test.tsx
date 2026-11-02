// marshal-owned renderer test
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs } from "@/test-utils";
import type { ContextPickerAPI, WorkspaceAPI } from "@/types/electron";

import { useContextSearch } from "./useContextSearch";

function installSearch(search: ContextPickerAPI["search"]) {
  window.contextPickerAPI = { search };
  return search;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useContextSearch", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("does not call IPC while disabled", async () => {
    const search = installSearch(
      vi.fn<ContextPickerAPI["search"]>().mockResolvedValue({ success: true, entities: [] }),
    );

    renderHook(() => useContextSearch({ query: "alice", enabled: false }), { wrapper });

    expect(search).not.toHaveBeenCalled();
  });

  it("surfaces IPC search errors", async () => {
    installSearch(
      vi.fn<ContextPickerAPI["search"]>().mockResolvedValue({
        success: false,
        error: "timeout",
      }),
    );

    const { result } = renderHook(() => useContextSearch({ query: "alice", enabled: true }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.error).toBe("timeout"));
    expect(result.current.entities).toEqual([]);
  });

  it("returns successful search results", async () => {
    installSearch(
      vi.fn<ContextPickerAPI["search"]>().mockResolvedValue({
        success: true,
        entities: [{ type: "People", id: "p1", displayName: "Alice" }],
      }),
    );

    const { result } = renderHook(() => useContextSearch({ query: "alice", enabled: true }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.entities).toHaveLength(1));
    expect(result.current.error).toBeNull();
  });

  it("searches local workspace files without calling the people search", async () => {
    const search = installSearch(
      vi.fn<ContextPickerAPI["search"]>().mockResolvedValue({ success: true, entities: [] }),
    );
    window.workspaceAPI.searchFiles = vi.fn<WorkspaceAPI["searchFiles"]>().mockResolvedValue({
      success: true,
      files: [
        {
          type: "File",
          id: "/workspace/report.md",
          title: "report.md",
          localPath: "/workspace/report.md",
        },
      ],
    });

    const { result } = renderHook(
      () =>
        useContextSearch({
          query: "report",
          enabled: true,
          entityTypes: ["File"],
          workspaceName: "Docs",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.entities).toHaveLength(1));
    expect(window.workspaceAPI.searchFiles).toHaveBeenCalledWith("Docs", "report");
    expect(search).not.toHaveBeenCalled();
  });

  it("does not process results from aborted queries", async () => {
    let resolveAlice!: (value: Awaited<ReturnType<ContextPickerAPI["search"]>>) => void;
    let resolveBob!: (value: Awaited<ReturnType<ContextPickerAPI["search"]>>) => void;
    const search = installSearch(
      vi.fn<ContextPickerAPI["search"]>().mockImplementation((query) => {
        if (query === "alice") {
          return new Promise((resolve) => {
            resolveAlice = resolve;
          });
        }
        return new Promise((resolve) => {
          resolveBob = resolve;
        });
      }),
    );

    const { result, rerender } = renderHook(
      ({ query, enabled }: { query: string; enabled: boolean }) =>
        useContextSearch({ query, enabled }),
      {
        wrapper,
        initialProps: { query: "alice", enabled: true },
      },
    );

    await waitFor(() => {
      expect(search).toHaveBeenCalledWith("alice", undefined);
    });

    rerender({ query: "bob", enabled: true });

    await waitFor(() => {
      expect(search).toHaveBeenCalledWith("bob", undefined);
    });

    await act(async () => {
      resolveBob({
        success: true,
        entities: [{ type: "People", id: "p2", displayName: "Bob" }],
      });
    });
    await waitFor(() =>
      expect(result.current.entities).toEqual([{ type: "People", id: "p2", displayName: "Bob" }]),
    );

    await act(async () => {
      resolveAlice({
        success: true,
        entities: [{ type: "People", id: "p1", displayName: "Alice" }],
      });
    });
    await waitFor(() =>
      expect(result.current.entities).toEqual([{ type: "People", id: "p2", displayName: "Bob" }]),
    );
  });
});
