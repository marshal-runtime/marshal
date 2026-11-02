import type {
  RuntimeExtensionsAPI,
  RuntimeExtensionsChangedEvent,
  RuntimeExtensionsScope,
} from "@common/marshal-ipc-contract";
import type { RuntimeExtensionCatalogEntry } from "@marshal/runtime/extensions";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { act, installMockAPIs, render, renderHook, waitFor } from "@/test-utils";

import { usePluginsData } from "./usePluginsData";

const RUNTIME_SCOPE: RuntimeExtensionsScope = {
  sessionId: "session-1",
  workspaceName: "workspace-1",
};

const MATCHING_ENTRY: RuntimeExtensionCatalogEntry = {
  id: "catalog://native/needle",
  identity: "@fixture/needle",
  version: "1.0.0",
  origin: "native",
  originLabel: "Native",
  title: "Needle Runtime",
  description: "Matching runtime extension",
  sourceId: "native",
  sourceLabel: "Native",
  sourceOrder: 0,
  order: 0,
  request: {
    packageRoot: "C:\\runtime-extensions\\needle",
    integrity: {
      algorithm: "sha256",
      domain: "marshal-runtime-extension-package-v1",
      value: "a".repeat(64),
    },
  },
  isCurrentVersion: true,
};

function usePluginsDataForTest(search: string) {
  return usePluginsData({
    isOpen: true,
    search,
    installingIds: new Set(),
    runtimeScope: RUNTIME_SCOPE,
  });
}

function PluginsDataProbe() {
  const data = usePluginsDataForTest("");
  return <div>{data.runtimeStatus?.revision ?? "loading"}</div>;
}

describe("usePluginsData Runtime extensions", () => {
  it("filters uncataloged status cards and catalog projections with the active search", async () => {
    installMockAPIs({
      runtimeExtensionsAPI: {
        search: vi.fn<RuntimeExtensionsAPI["search"]>().mockResolvedValue({
          success: true,
          value: {
            query: "needle",
            matches: [
              {
                entry: MATCHING_ENTRY,
                score: 1,
                matchedTerms: ["needle"],
                matchedFields: ["title"],
              },
            ],
          },
        }),
        status: vi.fn<RuntimeExtensionsAPI["status"]>().mockResolvedValue({
          success: true,
          value: {
            ...RUNTIME_SCOPE,
            revision: 1,
            scannedAt: "2026-08-29T00:00:00.000Z",
            discoveryStatus: "ready",
            items: [
              {
                candidateId: MATCHING_ENTRY.id,
                catalogEntryId: MATCHING_ENTRY.id,
                identity: MATCHING_ENTRY.identity,
                status: "detected",
                diagnostics: [],
              },
              {
                candidateId: "catalog://native/haystack",
                catalogEntryId: "catalog://native/haystack",
                identity: "@fixture/haystack",
                status: "detected",
                diagnostics: [],
              },
              {
                candidateId: "C:\\runtime-extensions\\needle-local",
                identity: "@fixture/needle-local",
                packageRoot: "C:\\runtime-extensions\\needle-local",
                status: "unbuilt",
                diagnostics: [],
              },
              {
                candidateId: "C:\\runtime-extensions\\haystack-local",
                identity: "@fixture/haystack-local",
                packageRoot: "C:\\runtime-extensions\\haystack-local",
                status: "invalid",
                diagnostics: [],
              },
            ],
            diagnostics: [],
          },
        }),
      },
    });

    const { result } = renderHook(() => usePluginsDataForTest("needle"));

    await waitFor(() => {
      expect(result.current.runtimeStatus?.items.map((item) => item.candidateId)).toEqual([
        MATCHING_ENTRY.id,
        "C:\\runtime-extensions\\needle-local",
      ]);
    });
    expect(result.current.runtimeCatalog).toEqual([MATCHING_ENTRY]);
  });

  it("invalidates live data only for matching sessions and workspaces", async () => {
    let changed: ((event: RuntimeExtensionsChangedEvent) => void) | undefined;
    const search = vi.fn<RuntimeExtensionsAPI["search"]>().mockResolvedValue({
      success: true,
      value: { query: "", matches: [] },
    });
    const status = vi.fn<RuntimeExtensionsAPI["status"]>().mockResolvedValue({
      success: true,
      value: {
        ...RUNTIME_SCOPE,
        revision: 1,
        scannedAt: "2026-08-29T00:00:00.000Z",
        discoveryStatus: "ready",
        items: [],
        diagnostics: [],
      },
    });
    installMockAPIs({
      runtimeExtensionsAPI: {
        search,
        status,
        onChanged: vi.fn<RuntimeExtensionsAPI["onChanged"]>().mockImplementation((callback) => {
          changed = callback;
          return () => undefined;
        }),
      },
    });

    renderHook(() => usePluginsDataForTest(""));
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(search).toHaveBeenCalled();
    expect(changed).toBeDefined();
    const initialSearchCalls = search.mock.calls.length;
    const initialStatusCalls = status.mock.calls.length;

    await act(async () => {
      changed?.({
        revision: 2,
        sessionId: "other-session",
        workspaceName: RUNTIME_SCOPE.workspaceName,
      });
      await Promise.resolve();
    });
    expect(search).toHaveBeenCalledTimes(initialSearchCalls);
    expect(status).toHaveBeenCalledTimes(initialStatusCalls);

    act(() => {
      changed?.({ revision: 3, ...RUNTIME_SCOPE });
    });
    await waitFor(() => expect(status.mock.calls.length).toBeGreaterThan(initialStatusCalls));
    expect(search.mock.calls.length).toBeGreaterThan(initialSearchCalls);
  });

  it("refetches fresh-looking cached data when the panel mounts after missed boot events", async () => {
    const search = vi.fn<RuntimeExtensionsAPI["search"]>().mockResolvedValue({
      success: true,
      value: { query: "", matches: [] },
    });
    const status = vi.fn<RuntimeExtensionsAPI["status"]>().mockResolvedValue({
      success: true,
      value: {
        ...RUNTIME_SCOPE,
        revision: 2,
        scannedAt: "2026-08-29T00:00:01.000Z",
        discoveryStatus: "ready",
        items: [],
        diagnostics: [],
      },
    });
    installMockAPIs({ runtimeExtensionsAPI: { search, status } });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["runtime-extensions", "catalog", RUNTIME_SCOPE, ""], []);
    queryClient.setQueryData(["runtime-extensions", "status", RUNTIME_SCOPE], {
      ...RUNTIME_SCOPE,
      revision: 1,
      scannedAt: "2026-08-29T00:00:00.000Z",
      discoveryStatus: "ready",
      items: [],
      diagnostics: [],
    });

    render(<PluginsDataProbe />, { queryClient });

    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(search).toHaveBeenCalled();
  });
});
