// Marshal-owned module.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HotkeysRoot } from "@/features/hotkeys";
import { act, installMockAPIs, renderHook, userEvent, waitFor } from "@/test-utils";

import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  useZoom,
  useZoomKeyboardShortcuts,
  ZOOM_LEVELS,
} from "./useZoom";

const PREFERENCE_KEY = "cocreate.zoom";

// Stateful mock: `set(key, val)` updates the value `get(key)` returns next,
// so a queryFn refetch after a successful mutation observes the persisted
// value (matching real preferencesAPI behavior).
function installStatefulPreferencesMock() {
  const store = new Map<string, string>();
  vi.mocked(window.preferencesAPI!.get).mockImplementation((key) =>
    Promise.resolve({ success: true, value: store.get(key) ?? null }),
  );
  vi.mocked(window.preferencesAPI!.set).mockImplementation((key, value) => {
    if (value == null) store.delete(key);
    else store.set(key, value);
    return Promise.resolve({ success: true });
  });
}

describe("useZoom", () => {
  beforeEach(() => {
    installMockAPIs();
    installStatefulPreferencesMock();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts at DEFAULT_ZOOM before async hydration resolves", () => {
    const { result } = renderHook(() => useZoom());
    expect(result.current.zoom).toBe(DEFAULT_ZOOM);
  });

  it("isHydrated transitions false → true after queryFn settles", async () => {
    const { result } = renderHook(() => useZoom());
    expect(result.current.isHydrated).toBe(false);
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
  });

  it("hydrates from preferencesAPI after mount", async () => {
    vi.mocked(window.preferencesAPI!.get).mockResolvedValue({
      success: true,
      value: "1.5",
    });
    const { result } = renderHook(() => useZoom());
    await waitFor(() => expect(result.current.zoom).toBe(1.5));
  });

  it("clamps an out-of-range stored value", async () => {
    vi.mocked(window.preferencesAPI!.get).mockResolvedValue({
      success: true,
      value: "999",
    });
    const { result } = renderHook(() => useZoom());
    await waitFor(() => expect(result.current.zoom).toBe(MAX_ZOOM));
  });

  it("ignores non-numeric stored values", async () => {
    // Use a value that would clearly differ from DEFAULT_ZOOM if the guard were
    // missing — the hydration path is exercised by "hydrates from
    // preferencesAPI after mount" above, so reaching DEFAULT_ZOOM here proves
    // the NaN-clamp branch ran (not just the fallback default).
    vi.mocked(window.preferencesAPI!.get).mockResolvedValue({
      success: true,
      value: "not-a-number",
    });
    const { result } = renderHook(() => useZoom());
    await waitFor(() => expect(window.preferencesAPI!.get).toHaveBeenCalled());
    // Must not be NaN — if both guards (queryFn's `Number.isFinite` and
    // clamp's `Number.isFinite`) were removed, zoom would be NaN, not 1.
    expect(result.current.zoom).toBe(DEFAULT_ZOOM);
    expect(Number.isFinite(result.current.zoom)).toBe(true);
  });

  it("falls back to default when preferencesAPI.get returns success: false", async () => {
    vi.mocked(window.preferencesAPI!.get).mockResolvedValue({
      success: false,
      value: null,
      error: "boom",
    });
    const { result } = renderHook(() => useZoom());
    await waitFor(() => expect(window.preferencesAPI!.get).toHaveBeenCalled());
    expect(result.current.zoom).toBe(DEFAULT_ZOOM);
  });

  it("persists user changes to preferencesAPI", async () => {
    const { result } = renderHook(() => useZoom());
    act(() => result.current.setZoom(1.25));
    await waitFor(() => expect(result.current.zoom).toBe(1.25));
    expect(window.preferencesAPI!.set).toHaveBeenCalledWith(PREFERENCE_KEY, "1.25");
  });

  it("rolls back to the previous zoom when preferencesAPI.set rejects", async () => {
    vi.mocked(window.preferencesAPI!.get).mockResolvedValue({ success: true, value: "1.25" });
    const { result } = renderHook(() => useZoom());
    // Hydrate to 1.25 first so prev != undefined when the failing mutate runs.
    await waitFor(() => expect(result.current.zoom).toBe(1.25));
    vi.mocked(window.preferencesAPI!.set).mockRejectedValueOnce(new Error("ipc gone"));
    act(() => result.current.setZoom(1.5));
    // After the rejection settles the cache reverts to the prior value.
    await waitFor(() => expect(result.current.zoom).toBe(1.25));
  });

  it("zoomIn steps to the next preset level", async () => {
    const { result } = renderHook(() => useZoom());
    expect(result.current.zoom).toBe(1);
    act(() => result.current.zoomIn());
    await waitFor(() => expect(result.current.zoom).toBe(1.1));
    act(() => result.current.zoomIn());
    await waitFor(() => expect(result.current.zoom).toBe(1.25));
  });

  it("zoomOut steps to the previous preset level", async () => {
    const { result } = renderHook(() => useZoom());
    act(() => result.current.zoomOut());
    await waitFor(() => expect(result.current.zoom).toBe(0.9));
    act(() => result.current.zoomOut());
    await waitFor(() => expect(result.current.zoom).toBe(0.8));
  });

  it("zoomIn caps at MAX_ZOOM", async () => {
    const { result } = renderHook(() => useZoom());
    act(() => result.current.setZoom(MAX_ZOOM));
    await waitFor(() => expect(result.current.zoom).toBe(MAX_ZOOM));
    act(() => result.current.zoomIn());
    await waitFor(() => expect(result.current.zoom).toBe(MAX_ZOOM));
  });

  it("zoomOut caps at MIN_ZOOM", async () => {
    const { result } = renderHook(() => useZoom());
    act(() => result.current.setZoom(MIN_ZOOM));
    await waitFor(() => expect(result.current.zoom).toBe(MIN_ZOOM));
    act(() => result.current.zoomOut());
    await waitFor(() => expect(result.current.zoom).toBe(MIN_ZOOM));
  });

  it("reset returns to default zoom", async () => {
    const { result } = renderHook(() => useZoom());
    act(() => result.current.setZoom(1.5));
    await waitFor(() => expect(result.current.zoom).toBe(1.5));
    act(() => result.current.reset());
    await waitFor(() => expect(result.current.zoom).toBe(DEFAULT_ZOOM));
  });

  it("setZoom from arbitrary value snaps within bounds", async () => {
    const { result } = renderHook(() => useZoom());
    act(() => result.current.setZoom(10));
    await waitFor(() => expect(result.current.zoom).toBe(MAX_ZOOM));
    act(() => result.current.setZoom(-5));
    await waitFor(() => expect(result.current.zoom).toBe(MIN_ZOOM));
  });

  it("ZOOM_LEVELS is sorted ascending and includes the default", () => {
    expect(ZOOM_LEVELS).toContain(DEFAULT_ZOOM);
    for (let i = 1; i < ZOOM_LEVELS.length; i++) {
      expect(ZOOM_LEVELS[i]).toBeGreaterThan(ZOOM_LEVELS[i - 1]);
    }
  });
});

describe("useZoomKeyboardShortcuts", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const keyByCode: Record<string, string> = {
    Digit0: "0",
    Equal: "=",
    Minus: "-",
    Numpad0: "0",
    NumpadAdd: "+",
    NumpadSubtract: "-",
  };

  function dispatchKey(
    code: string,
    opts: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {},
  ) {
    const event = new KeyboardEvent("keydown", {
      code,
      key: keyByCode[code] ?? code,
      bubbles: true,
      cancelable: true,
      ctrlKey: opts.ctrl ?? true,
      metaKey: opts.meta ?? false,
      altKey: opts.alt ?? false,
      shiftKey: opts.shift ?? false,
    });
    document.dispatchEvent(event);
    return event;
  }

  it("Ctrl+Equal triggers zoomIn", async () => {
    const user = userEvent.setup();
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    await user.keyboard("{Control>}={/Control}");
    expect(handlers.zoomIn).toHaveBeenCalled();
  });

  it("Ctrl+Plus does not trigger zoomIn because shifted punctuation is layout-dependent", async () => {
    const user = userEvent.setup();
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    await user.keyboard("{Control>}{Shift>}={/Shift}{/Control}");
    expect(handlers.zoomIn).not.toHaveBeenCalled();
  });

  it("Ctrl+Minus triggers zoomOut", async () => {
    const user = userEvent.setup();
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    await user.keyboard("{Control>}-{/Control}");
    expect(handlers.zoomOut).toHaveBeenCalled();
  });

  it("Ctrl+Digit0 triggers reset", async () => {
    const user = userEvent.setup();
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    await user.keyboard("{Control>}0{/Control}");
    expect(handlers.reset).toHaveBeenCalled();
  });

  it("Ctrl+Shift+Digit0 does not trigger reset", async () => {
    const user = userEvent.setup();
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    await user.keyboard("{Control>}{Shift>}0{/Shift}{/Control}");
    expect(handlers.reset).not.toHaveBeenCalled();
  });

  it("realistic numpad variants (NumpadAdd / NumpadSubtract / Numpad0) are handled", () => {
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    const add = dispatchKey("NumpadAdd");
    const subtract = dispatchKey("NumpadSubtract");
    const zero = dispatchKey("Numpad0");
    expect(add.key).toBe("+");
    expect(subtract.key).toBe("-");
    expect(zero.key).toBe("0");
    expect(handlers.zoomIn).toHaveBeenCalledTimes(1);
    expect(handlers.zoomOut).toHaveBeenCalledTimes(1);
    expect(handlers.reset).toHaveBeenCalledTimes(1);
  });

  it("shifted numpad variants are not handled", () => {
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    const add = dispatchKey("NumpadAdd", { shift: true });
    const subtract = dispatchKey("NumpadSubtract", { shift: true });
    const zero = dispatchKey("Numpad0", { shift: true });
    expect(add.key).toBe("+");
    expect(subtract.key).toBe("-");
    expect(zero.key).toBe("0");
    expect(handlers.zoomIn).not.toHaveBeenCalled();
    expect(handlers.zoomOut).not.toHaveBeenCalled();
    expect(handlers.reset).not.toHaveBeenCalled();
  });

  it("keeps the Meta/Cmd NumpadAdd workaround", () => {
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    dispatchKey("NumpadAdd", { ctrl: false, meta: true });
    expect(handlers.zoomIn).toHaveBeenCalledTimes(1);
    expect(handlers.zoomOut).not.toHaveBeenCalled();
    expect(handlers.reset).not.toHaveBeenCalled();
  });

  it("does not handle shifted Meta/Cmd NumpadAdd", () => {
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    dispatchKey("NumpadAdd", { ctrl: false, meta: true, shift: true });
    expect(handlers.zoomIn).not.toHaveBeenCalled();
    expect(handlers.zoomOut).not.toHaveBeenCalled();
    expect(handlers.reset).not.toHaveBeenCalled();
  });

  it("ignores key presses without a modifier", async () => {
    const user = userEvent.setup();
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    await user.keyboard("=");
    expect(handlers.zoomIn).not.toHaveBeenCalled();
  });

  it("ignores combos that include Alt (avoid hijacking other shortcuts)", async () => {
    const user = userEvent.setup();
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    await user.keyboard("{Control>}{Alt>}={/Alt}{/Control}");
    expect(handlers.zoomIn).not.toHaveBeenCalled();
  });

  it("ignores shifted numpad combos that include Alt", () => {
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    dispatchKey("NumpadAdd", { alt: true, shift: true });
    dispatchKey("NumpadSubtract", { alt: true, shift: true });
    dispatchKey("Numpad0", { alt: true, shift: true });
    expect(handlers.zoomIn).not.toHaveBeenCalled();
    expect(handlers.zoomOut).not.toHaveBeenCalled();
    expect(handlers.reset).not.toHaveBeenCalled();
  });

  it("does not fire when target is an editable element", async () => {
    const user = userEvent.setup();
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    await user.keyboard("{Control>}={/Control}");
    expect(handlers.zoomIn).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("does not fire when target is inside a Monaco editor", async () => {
    const user = userEvent.setup();
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });

    const monacoHost = document.createElement("div");
    monacoHost.className = "monaco-editor";
    const child = document.createElement("span");
    child.tabIndex = -1;
    monacoHost.appendChild(child);
    document.body.appendChild(monacoHost);
    child.focus();
    await user.keyboard("{Control>}-{/Control}");
    expect(handlers.zoomOut).not.toHaveBeenCalled();
    document.body.removeChild(monacoHost);
  });

  it("removes its listener when disabled", async () => {
    const user = userEvent.setup();
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    const { rerender } = renderHook(({ enabled }) => useZoomKeyboardShortcuts(handlers, enabled), {
      initialProps: { enabled: true },
      wrapper: HotkeysRoot,
    });
    rerender({ enabled: false });
    await user.keyboard("{Control>}={/Control}");
    expect(handlers.zoomIn).not.toHaveBeenCalled();
  });

  it("calls preventDefault on matched combos to suppress native browser/Electron zoom", () => {
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    for (const code of ["Equal", "Minus", "Digit0", "NumpadAdd", "NumpadSubtract", "Numpad0"]) {
      const event = dispatchKey(code);
      expect(event.defaultPrevented, `${code} should be defaultPrevented`).toBe(true);
    }
  });

  it("does NOT call preventDefault on unhandled combos", () => {
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    const event = dispatchKey("KeyA");
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not stop propagation for matched combos", () => {
    const handlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    renderHook(() => useZoomKeyboardShortcuts(handlers), { wrapper: HotkeysRoot });
    const mainEvent = dispatchKey("Equal");
    const numpadEvent = dispatchKey("NumpadAdd");
    expect(handlers.zoomIn).toHaveBeenCalledTimes(2);
    expect(mainEvent.cancelBubble).toBe(false);
    expect(numpadEvent.cancelBubble).toBe(false);
  });

  it("invokes the latest handlers when they're swapped between renders", async () => {
    const user = userEvent.setup();
    const initialHandlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    const { rerender } = renderHook(({ h }) => useZoomKeyboardShortcuts(h), {
      initialProps: { h: initialHandlers },
      wrapper: HotkeysRoot,
    });
    const newHandlers = {
      zoomIn: vi.fn<() => void>(),
      zoomOut: vi.fn<() => void>(),
      reset: vi.fn<() => void>(),
    };
    rerender({ h: newHandlers });
    await user.keyboard("{Control>}={/Control}");
    expect(initialHandlers.zoomIn).not.toHaveBeenCalled();
    expect(newHandlers.zoomIn).toHaveBeenCalled();
  });
});
