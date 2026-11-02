import type { RuntimeUiAPI, SessionMetadata, WorkspaceAPI } from "@common/marshal-ipc-contract";
import { MARSHAL_RUNTIME_DEFAULT_WORKSPACE, RUNTIME_UI_HOST_PLACEMENTS } from "@common/runtime-ui";
import type {
  RuntimeUiCommandResult,
  RuntimeUiEvent,
  RuntimeUiInstance,
  RuntimeUiPlacementSnapshot,
  RuntimeUiSnapshot,
} from "@common/runtime-ui";
import { SWARM_RUN_VIEW_RENDER_ID } from "@marshal/swarm/presentation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { act, installMockAPIs, renderHook, waitFor } from "@/test-utils";

import { useRuntimeUi, useRuntimeUiScope } from "./useRuntimeUi";

const scope = { sessionId: "session-1", workspaceName: "Workspace One" };
const placementSnapshot: RuntimeUiPlacementSnapshot = {
  revision: 0,
  generatedAt: "2026-08-14T08:00:00.000Z",
  placements: RUNTIME_UI_HOST_PLACEMENTS.map((metadata) => ({
    metadata,
    applications: [],
  })),
  diagnostics: [],
};

function session(): SessionMetadata {
  return {
    id: scope.sessionId,
    name: "Runtime session",
    createdAt: "2026-08-14T08:00:00.000Z",
    updatedAt: "2026-08-14T08:00:00.000Z",
    hasUnread: false,
    isActive: true,
    workspaceName: scope.workspaceName,
  };
}

function instance(overrides: Partial<RuntimeUiInstance> = {}): RuntimeUiInstance {
  return {
    instanceId: "instance-1",
    owner: {
      ...scope,
      extensionId: "extension.one",
      applicationId: "application.one",
    },
    surface: "panel",
    content: { kind: "text", text: "Initial content" },
    idempotencyKey: "open-1",
    revision: 4,
    openedAt: "2026-08-14T08:00:00.000Z",
    updatedAt: "2026-08-14T08:00:00.000Z",
    focusedAt: "2026-08-14T08:00:00.000Z",
    ...overrides,
  };
}

function snapshot(
  instances: readonly RuntimeUiInstance[] = [instance()],
  revision = 4,
): RuntimeUiSnapshot {
  return {
    revision,
    generatedAt: "2026-08-14T08:00:00.000Z",
    scope,
    instances,
    events: [],
  };
}

function commandResult(
  action: RuntimeUiCommandResult["receipt"]["action"],
  value?: RuntimeUiInstance,
): RuntimeUiCommandResult {
  return {
    receipt: {
      receiptId: `receipt-${action}`,
      action,
      status: "applied",
      completedAt: "2026-08-14T08:00:01.000Z",
      revision: value?.revision ?? 5,
      instanceId: value?.instanceId,
    },
    instance: value,
  };
}

function createRuntimeUiApi(initialSnapshot = snapshot()) {
  let currentSnapshot = initialSnapshot;
  let listener: ((event: RuntimeUiEvent) => void) | undefined;
  const api: RuntimeUiAPI = {
    getSnapshot: vi.fn<RuntimeUiAPI["getSnapshot"]>().mockImplementation(async () => ({
      success: true,
      value: currentSnapshot,
    })),
    subscribe: vi.fn<RuntimeUiAPI["subscribe"]>().mockImplementation(async () => ({
      success: true,
      value: currentSnapshot,
    })),
    unsubscribe: vi.fn<RuntimeUiAPI["unsubscribe"]>().mockResolvedValue({ success: true }),
    open: vi
      .fn<RuntimeUiAPI["open"]>()
      .mockResolvedValue({ success: true, value: commandResult("open") }),
    update: vi.fn<RuntimeUiAPI["update"]>().mockImplementation(async (request) => ({
      success: true,
      value: commandResult("update", {
        ...instance(),
        content: request.content,
        revision: 5,
      }),
    })),
    focus: vi.fn<RuntimeUiAPI["focus"]>().mockImplementation(async () => ({
      success: true,
      value: commandResult("focus", {
        ...instance(),
        revision: 5,
        focusedAt: "2026-08-14T08:00:01.000Z",
      }),
    })),
    close: vi
      .fn<RuntimeUiAPI["close"]>()
      .mockResolvedValue({ success: true, value: commandResult("close") }),
    list: vi
      .fn<RuntimeUiAPI["list"]>()
      .mockResolvedValue({ success: true, value: commandResult("list") }),
    getPlacements: vi.fn<RuntimeUiAPI["getPlacements"]>().mockResolvedValue(placementSnapshot),
    activatePlacement: vi.fn<RuntimeUiAPI["activatePlacement"]>(),
    onEvent: vi
      .fn<RuntimeUiAPI["onEvent"]>()
      .mockImplementation((callback: (event: RuntimeUiEvent) => void) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      }),
  };
  return {
    api,
    emit(event: RuntimeUiEvent) {
      listener?.(event);
    },
    setSnapshot(next: RuntimeUiSnapshot) {
      currentSnapshot = next;
    },
  };
}

describe("useRuntimeUi", () => {
  beforeEach(() => {
    installMockAPIs({
      workspaceAPI: {
        getUIState: vi.fn<WorkspaceAPI["getUIState"]>().mockResolvedValue({
          success: true,
          state: {
            activeWorkspace: "Fallback workspace",
            expandedPaths: {},
            selectedFiles: {},
          },
        }),
      },
    });
  });

  it("resolves the active scope, hydrates snapshots, subscribes, and unsubscribes", async () => {
    const runtime = createRuntimeUiApi();
    window.runtimeUiAPI = runtime.api;
    const { result, unmount } = renderHook(() =>
      useRuntimeUi({ activeSessionId: scope.sessionId, sessions: [session()] }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.scope).toEqual(scope);
    expect(result.current.bySurface.panel).toHaveLength(1);
    expect(runtime.api.getSnapshot).toHaveBeenCalledWith(scope);
    expect(runtime.api.subscribe).toHaveBeenCalledWith(scope);

    unmount();
    expect(runtime.api.unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps the shared scope subscribed until its last consumer unmounts", async () => {
    const runtime = createRuntimeUiApi();
    window.runtimeUiAPI = runtime.api;
    const { unmount: unmountHost } = renderHook(() => useRuntimeUiScope(scope));
    const { unmount: unmountCompanion } = renderHook(() => useRuntimeUiScope(scope));
    await waitFor(() => expect(runtime.api.subscribe).toHaveBeenCalledTimes(2));

    unmountCompanion();
    expect(runtime.api.unsubscribe).not.toHaveBeenCalled();

    unmountHost();
    expect(runtime.api.unsubscribe).toHaveBeenCalledOnce();
    expect(runtime.api.unsubscribe).toHaveBeenCalledWith(scope);
  });

  it("uses the runtime default for an unbound session instead of the active Create workspace", async () => {
    const defaultScope = {
      sessionId: scope.sessionId,
      workspaceName: MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
    };
    const runtime = createRuntimeUiApi({
      ...snapshot([], 0),
      scope: defaultScope,
    });
    window.runtimeUiAPI = runtime.api;
    const unboundSession = {
      ...session(),
      workspaceName: undefined,
      originWorkspaceName: "Workspace One",
    };
    const { result } = renderHook(() =>
      useRuntimeUi({ activeSessionId: scope.sessionId, sessions: [unboundSession] }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.scope).toEqual(defaultScope);
    expect(runtime.api.getSnapshot).toHaveBeenCalledWith(defaultScope);
    expect(runtime.api.subscribe).toHaveBeenCalledWith(defaultScope);
  });

  it("waits for active session metadata before requesting an authority scope", async () => {
    const defaultScope = {
      sessionId: scope.sessionId,
      workspaceName: MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
    };
    const runtime = createRuntimeUiApi({
      ...snapshot([], 0),
      scope: defaultScope,
    });
    window.runtimeUiAPI = runtime.api;
    const { result, rerender } = renderHook(
      ({ sessions }: { sessions: readonly SessionMetadata[] }) =>
        useRuntimeUi({ activeSessionId: scope.sessionId, sessions }),
      { initialProps: { sessions: [] as readonly SessionMetadata[] } },
    );

    expect(result.current.status).toBe("idle");
    expect(result.current.scope).toBeNull();
    expect(runtime.api.getSnapshot).not.toHaveBeenCalled();

    rerender({ sessions: [{ ...session(), workspaceName: undefined }] });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(runtime.api.getSnapshot).toHaveBeenCalledWith(defaultScope);
  });

  it("applies newer ordered events, ignores stale revisions, and removes invalidated owners", async () => {
    const runtime = createRuntimeUiApi();
    window.runtimeUiAPI = runtime.api;
    const { result } = renderHook(() =>
      useRuntimeUi({ activeSessionId: scope.sessionId, sessions: [session()] }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const updated = instance({
      content: { kind: "text", text: "Newest content" },
      revision: 6,
      updatedAt: "2026-08-14T08:00:02.000Z",
    });
    act(() => {
      runtime.emit({
        type: "instance-updated",
        sequence: 6,
        occurredAt: "2026-08-14T08:00:02.000Z",
        scope,
        instance: updated,
      });
      runtime.emit({
        type: "instance-updated",
        sequence: 5,
        occurredAt: "2026-08-14T08:00:01.000Z",
        scope,
        instance: instance({
          content: { kind: "text", text: "Stale content" },
          revision: 5,
        }),
      });
    });
    expect(result.current.instances[0].content).toEqual({
      kind: "text",
      text: "Newest content",
    });

    act(() =>
      runtime.emit({
        type: "owner-invalidated",
        sequence: 7,
        occurredAt: "2026-08-14T08:00:03.000Z",
        scope,
        owner: {
          extensionId: updated.owner.extensionId,
          applicationId: updated.owner.applicationId,
        },
        closedInstanceIds: [],
      }),
    );
    expect(result.current.instances).toHaveLength(0);
  });

  it("resyncs from the authoritative snapshot when the window reconnects", async () => {
    const runtime = createRuntimeUiApi();
    window.runtimeUiAPI = runtime.api;
    const { result } = renderHook(() =>
      useRuntimeUi({ activeSessionId: scope.sessionId, sessions: [session()] }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    runtime.setSnapshot(
      snapshot(
        [
          instance({
            content: { kind: "text", text: "Recovered after reconnect" },
            revision: 9,
          }),
        ],
        9,
      ),
    );
    void act(() => window.dispatchEvent(new Event("online")));

    await waitFor(() =>
      expect(result.current.instances[0].content).toEqual({
        kind: "text",
        text: "Recovered after reconnect",
      }),
    );
    expect(runtime.api.getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("rolls back optimistic close failures and exposes the actionable error", async () => {
    const runtime = createRuntimeUiApi();
    let resolveClose: ((value: Awaited<ReturnType<RuntimeUiAPI["close"]>>) => void) | undefined;
    runtime.api.close = vi.fn<RuntimeUiAPI["close"]>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveClose = resolve;
        }),
    );
    window.runtimeUiAPI = runtime.api;
    const { result } = renderHook(() =>
      useRuntimeUi({ activeSessionId: scope.sessionId, sessions: [session()] }),
    );
    await waitFor(() => expect(result.current.instances).toHaveLength(1));
    const target = result.current.instances[0];

    let closePromise: Promise<boolean> | undefined;
    act(() => {
      closePromise = result.current.close(target);
    });
    expect(result.current.instances).toHaveLength(0);
    expect(result.current.pending.get(target.instanceId)?.operation).toBe("close");

    resolveClose?.({
      success: false,
      error: { code: "permission-denied", message: "Close denied" },
    });
    let closeResult: boolean | undefined;
    await act(async () => {
      closeResult = await closePromise;
    });

    expect(closeResult).toBe(false);
    expect(result.current.instances).toEqual([target]);
    expect(result.current.error).toEqual({
      code: "permission-denied",
      message: "Close denied",
    });
  });

  it("reports the unavailable bridge instead of leaving the scoped store loading, without surfacing a user-facing error", async () => {
    // No window.runtimeUiAPI at all (e.g. the mobile web client, which has no
    // Electron preload bridge) is a structural, permanent condition for the
    // whole session — not a transient backend failure — so it must not
    // populate `error` (which would drive a recurring destructive alert with
    // a Reload button that can't actually do anything here).
    window.runtimeUiAPI = undefined;
    const { result } = renderHook(() =>
      useRuntimeUi({ activeSessionId: scope.sessionId, sessions: [session()] }),
    );

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.error).toBeNull();
  });
});

it("keeps Swarm instances available to Progress without allocating a second runtime surface", async () => {
  const swarm = instance({
    content: {
      kind: "application",
      renderId: SWARM_RUN_VIEW_RENDER_ID,
      resource: { uri: "ui://marshal/swarm/run", mimeType: "text/html" },
      descriptor: { version: "1.0.0", presentationModes: ["pip"], actions: [], tools: [] },
      state: { run: { runId: "run-1" } },
    },
  });
  const { api } = createRuntimeUiApi(snapshot([swarm]));
  window.runtimeUiAPI = api;
  const { result } = renderHook(() =>
    useRuntimeUi({ activeSessionId: scope.sessionId, sessions: [session()] }),
  );
  await waitFor(() => expect(result.current.instances).toHaveLength(1));
  expect(result.current.instances[0]).toEqual(swarm);
  expect(result.current.bySurface.panel).toEqual([]);
  expect(result.current.bySurface["inline-card"]).toEqual([]);
});
