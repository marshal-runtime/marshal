import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs } from "@/test-utils";
import type { PermissionCardData } from "@/types/electron";

import { permissionCardsStore } from "../permissions/state/permission-cards-store";
import { usePermissions } from "./usePermissions";

vi.mock("@/services/copilot", () => ({
  copilotService: {
    onEvent: vi.fn<() => () => void>().mockReturnValue(() => {}),
  },
}));

vi.mock("../permissions/state/permission-cards-store", () => {
  const listeners = new Set<() => void>();
  let cache = new Map<string, PermissionCardData[]>();
  const EMPTY: PermissionCardData[] = [];
  return {
    permissionCardsStore: {
      subscribe: vi.fn<(cb: () => void) => () => void>((cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      }),
      getSnapshot: vi.fn<(sessionId: string) => PermissionCardData[]>(
        (sessionId: string) => cache.get(sessionId) ?? EMPTY,
      ),
      fetch: vi.fn<(sessionId: string) => Promise<void>>(async () => {}),
      optimisticUpdate: vi.fn<
        (sessionId: string, updater: (cards: PermissionCardData[]) => PermissionCardData[]) => void
      >((sessionId: string, updater: (cards: PermissionCardData[]) => PermissionCardData[]) => {
        const current = cache.get(sessionId) ?? [];
        cache.set(sessionId, updater(current));
        listeners.forEach((l) => l());
      }),
      clear: vi.fn<(sessionId: string) => void>((sessionId: string) => {
        cache.delete(sessionId);
        listeners.forEach((l) => l());
      }),
      // Test helper to inject cards into the mock store
      _setCards: (sessionId: string, cards: PermissionCardData[]) => {
        cache.set(sessionId, cards);
        listeners.forEach((l) => l());
      },
      _reset: () => {
        cache = new Map();
      },
    },
  };
});

function makeCard(id: string, overrides: Partial<PermissionCardData> = {}): PermissionCardData {
  return {
    id,
    kind: "shell",
    title: `Run command ${id}`,
    message: "wants to run a command",
    detail: `echo ${id}`,
    buttons: ["Allow", "Deny"],
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only helpers added by vi.mock above
const mockStore = permissionCardsStore as typeof permissionCardsStore & {
  _setCards: (sessionId: string, cards: PermissionCardData[]) => void;
  _reset: () => void;
};

describe("usePermissions", () => {
  beforeEach(() => {
    installMockAPIs();
    mockStore._reset();
    vi.clearAllMocks();
  });

  it("starts with empty cards", () => {
    const { result } = renderHook(() => usePermissions("test-session"));
    expect(result.current.cards).toEqual([]);
  });

  it("fetches cards on mount via store.fetch", () => {
    renderHook(() => usePermissions("test-session"));
    expect(permissionCardsStore.fetch).toHaveBeenCalledWith("test-session");
  });

  it("returns cards from the store for the current session", () => {
    mockStore._setCards("test-session", [makeCard("p1", { sessionId: "test-session" })]);
    const { result } = renderHook(() => usePermissions("test-session"));
    expect(result.current.cards).toHaveLength(1);
    expect(result.current.cards[0].id).toBe("p1");
  });

  it("re-fetches when sessionId changes", () => {
    const { rerender } = renderHook(({ sid }) => usePermissions(sid), {
      initialProps: { sid: "session-A" },
    });

    expect(permissionCardsStore.fetch).toHaveBeenCalledWith("session-A");
    vi.mocked(permissionCardsStore.fetch).mockClear();

    rerender({ sid: "session-B" });
    expect(permissionCardsStore.fetch).toHaveBeenCalledWith("session-B");
  });

  it("respond() does optimistic update and calls resolvePermission IPC", async () => {
    mockStore._setCards("test-session", [makeCard("p1", { sessionId: "test-session" })]);
    const { result } = renderHook(() => usePermissions("test-session"));

    await act(async () => {
      await result.current.respond("p1", "allow");
    });

    expect(permissionCardsStore.optimisticUpdate).toHaveBeenCalled();
    expect(window.copilotAPI.resolvePermission).toHaveBeenCalledWith("p1", "allow", undefined);
  });

  it("respond() threads overridePattern to resolvePermission", async () => {
    mockStore._setCards("test-session", [makeCard("p1", { sessionId: "test-session" })]);
    const { result } = renderHook(() => usePermissions("test-session"));

    await act(async () => {
      await result.current.respond("p1", "always-allow", "npm install *");
    });

    expect(window.copilotAPI.resolvePermission).toHaveBeenCalledWith(
      "p1",
      "always-allow",
      "npm install *",
    );
  });

  it("respond() sets resolved to denied for Deny action", async () => {
    mockStore._setCards("test-session", [makeCard("p1", { sessionId: "test-session" })]);
    const { result } = renderHook(() => usePermissions("test-session"));

    await act(async () => {
      await result.current.respond("p1", "deny");
    });

    // Optimistic update should have been called with deny → denied
    expect(permissionCardsStore.optimisticUpdate).toHaveBeenCalled();
    expect(result.current.cards[0].resolved).toBe("denied");
  });

  it("clear() clears the store and calls clearCards IPC", () => {
    mockStore._setCards("test-session", [makeCard("p1", { sessionId: "test-session" })]);
    const { result } = renderHook(() => usePermissions("test-session"));

    act(() => {
      result.current.clear();
    });

    expect(permissionCardsStore.clear).toHaveBeenCalledWith("test-session");
    expect(window.permissionsAPI!.clearCards).toHaveBeenCalledWith("test-session");
  });

  it("handles null sessionId gracefully", () => {
    const { result } = renderHook(() => usePermissions(null));
    expect(result.current.cards).toEqual([]);
    expect(permissionCardsStore.fetch).not.toHaveBeenCalled();
  });
});
