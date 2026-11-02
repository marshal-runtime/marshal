// src/features/workflows/useWorkflowEvents.test.tsx
//
// Verifies useRunSnapshot pulls an initial snapshot and folds in event
// batches arriving via the subscription channel.

import type { WorkflowsAPI } from "@common/marshal-ipc-contract";
import type { RunSnapshot, WorkflowEvent } from "@common/workflows-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useRunSnapshot } from "./useWorkflowEvents";

type EventCallback = Parameters<NonNullable<WorkflowsAPI["subscribeRunEvents"]>>[1];

function makeApi(): { api: WorkflowsAPI; emit: (batch: WorkflowEvent[]) => void } {
  const eventCallbacks = new Set<EventCallback>();
  const fakeSnapshot = (runId: string): RunSnapshot => ({
    runId,
    runFamilyId: runId,
    workflowId: "wf",
    workflowVersion: "1.0.0",
    status: "running",
    startedAt: 0,
    input: null,
    steps: [],
    agents: {},
    capacity: { activeSubagents: 0, globalLimit: 8, perRunLimit: 8, queued: 0 },
    artifacts: [],
    events: { lastSeq: -1 },
  });

  const api: Partial<WorkflowsAPI> = {
    list: vi.fn<WorkflowsAPI["list"]>(),
    listRuns: vi.fn<WorkflowsAPI["listRuns"]>(),
    getRun: vi.fn<WorkflowsAPI["getRun"]>(async (runId: string) => ({
      success: true,
      snapshot: fakeSnapshot(runId),
    })),
    getEvents: vi.fn<WorkflowsAPI["getEvents"]>(),
    run: vi.fn<WorkflowsAPI["run"]>(),
    cancel: vi.fn<WorkflowsAPI["cancel"]>(),
    retryFromStep: vi.fn<WorkflowsAPI["retryFromStep"]>(),
    installLocal: vi.fn<WorkflowsAPI["installLocal"]>(),
    pickInstallDir: vi.fn<WorkflowsAPI["pickInstallDir"]>(),
    permissionResponse: vi.fn<WorkflowsAPI["permissionResponse"]>(),
    subscribeRunEvents: vi.fn<WorkflowsAPI["subscribeRunEvents"]>(
      (_runId: string, cb: EventCallback) => {
        eventCallbacks.add(cb);
        return () => {
          eventCallbacks.delete(cb);
        };
      },
    ),
    subscribeRunStatus: vi.fn<WorkflowsAPI["subscribeRunStatus"]>(() => () => {}),
    subscribeRunTick: vi.fn<WorkflowsAPI["subscribeRunTick"]>(() => () => {}),
    subscribePermissionRequests: vi.fn<WorkflowsAPI["subscribePermissionRequests"]>(() => () => {}),
  };

  const emit = (batch: WorkflowEvent[]): void => {
    for (const cb of eventCallbacks) cb({ runId: "r1", batch });
  };

  // The Partial<> shape is filled out above; we use a single intentional
  // assertion so the rest of the test body stays clean.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return { api: api as unknown as WorkflowsAPI, emit };
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useRunSnapshot", () => {
  let originalApi: WorkflowsAPI | undefined;

  beforeEach(() => {
    originalApi = window.workflowsAPI;
  });

  afterEach(() => {
    window.workflowsAPI = originalApi;
  });

  test("pulls initial snapshot via getRun and exposes loading state", async () => {
    const { api } = makeApi();
    window.workflowsAPI = api;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useRunSnapshot("r1"), {
      wrapper: wrapper(client),
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(api.getRun).toHaveBeenCalledWith("r1");
    expect(result.current.snapshot.runId).toBe("r1");
  });

  test("folds in event batches and trims the recentEvents ring", async () => {
    const { api, emit } = makeApi();
    window.workflowsAPI = api;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useRunSnapshot("r1"), {
      wrapper: wrapper(client),
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      emit([
        {
          seq: 0,
          ts: 100,
          type: "step.started",
          payload: {
            stepKey: "s1",
            label: "load",
            parentStepKey: "",
            startedAt: 100,
          },
        },
      ]);
    });

    await waitFor(() => {
      expect(result.current.snapshot.steps).toHaveLength(1);
    });
    expect(result.current.snapshot.steps[0].label).toBe("load");
    expect(result.current.recentEvents).toHaveLength(1);
  });

  test("handles missing window.workflowsAPI gracefully", async () => {
    window.workflowsAPI = undefined;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useRunSnapshot("r1"), {
      wrapper: wrapper(client),
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.snapshot.runId).toBe("r1");
    expect(result.current.snapshot.status).toBe("pending");
  });
});
