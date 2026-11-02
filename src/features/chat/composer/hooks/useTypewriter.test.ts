// Marshal-owned module.
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

import { useTypewriter } from "./useTypewriter";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockReducedMotion(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q) =>
      ({
        matches: q === "(prefers-reduced-motion: reduce)" ? matches : false,
        media: q,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

/** Captures rAF callbacks so tests can drive them frame-by-frame and have
 * cancelAnimationFrame actually drop queued frames (not just no-op). */
function installRafQueue() {
  const pending: Array<{ id: number; cb: FrameRequestCallback } | null> = [];
  let nextId = 0;
  const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
    nextId += 1;
    pending.push({ id: nextId, cb });
    return nextId;
  });
  const cafSpy = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    const idx = pending.findIndex((f) => f !== null && f.id === id);
    if (idx >= 0) pending[idx] = null;
  });
  let now = 0;
  // Mock performance.now() so the hook's `start = performance.now()` lives on the
  // same synthetic clock as the rAF queue. Otherwise `start` is a real wall-clock
  // value (~1e12 ms) while frame timestamps start at 0, making `progress` a huge
  // negative number whose easing-curve output depends on cos() precision at
  // extreme values — passes on some machines, fails flakily on others.
  const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
  return {
    rafSpy,
    cafSpy,
    perfSpy,
    /** Drives the head of the queue with a synthetic timestamp. */
    drain(stepMs = 16) {
      while (pending.length > 0 && pending[0] === null) pending.shift();
      const frame = pending.shift();
      if (!frame) return false;
      now += stepMs;
      act(() => frame.cb(now));
      return true;
    },
    pendingCount() {
      return pending.filter((f) => f !== null).length;
    },
  };
}

describe("useTypewriter", () => {
  it("commits the full text immediately and skips rAF when prefers-reduced-motion is set", () => {
    mockReducedMotion(true);
    const setter = vi.fn<(text: string) => void>();
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");

    const { result } = renderHook(() => useTypewriter(setter));
    act(() => {
      result.current.startTyping("hello world");
    });

    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith("hello world");
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it("seeds the editor with the first character synchronously to avoid placeholder flash", () => {
    mockReducedMotion(false);
    const setter = vi.fn<(text: string) => void>();
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);

    const { result } = renderHook(() => useTypewriter(setter));
    act(() => {
      result.current.startTyping("hello");
    });

    // Regression guard: we MUST NOT setter("") before the rAF loop —
    // an empty editor would render the placeholder for one frame.
    expect(setter).not.toHaveBeenCalledWith("");
    expect(setter).toHaveBeenCalledWith("h");
  });

  it("commits empty string immediately for empty text regardless of motion preference", () => {
    mockReducedMotion(false);
    const setter = vi.fn<(text: string) => void>();
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");

    const { result } = renderHook(() => useTypewriter(setter));
    act(() => {
      result.current.startTyping("");
    });

    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith("");
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it("drips text across multiple frames with progressively longer prefixes ending on the full string", () => {
    mockReducedMotion(false);
    const setter = vi.fn<(text: string) => void>();
    const raf = installRafQueue();

    const { result } = renderHook(() => useTypewriter(setter));
    act(() => {
      result.current.startTyping("hello world");
    });

    let safety = 500;
    while (raf.drain() && safety-- > 0) {
      // keep draining until the loop finishes
    }

    const calls = setter.mock.calls.map((c) => c[0]);
    expect(calls.length).toBeGreaterThan(2); // synchronous seed + at least a couple of frames
    expect(calls[0]).toBe("h"); // synchronous seed
    expect(calls[calls.length - 1]).toBe("hello world"); // ends on full text

    // Each call must be a prefix of the final text and never shorter than the previous one.
    let prevLen = 0;
    for (const c of calls) {
      expect("hello world").toMatch(new RegExp("^" + c.replace(/[\s]/g, "\\s")));
      expect(c.length).toBeGreaterThanOrEqual(prevLen);
      prevLen = c.length;
    }
  });

  it("cancel() stops further frames from firing the setter mid-drip", () => {
    mockReducedMotion(false);
    const setter = vi.fn<(text: string) => void>();
    const raf = installRafQueue();

    const { result } = renderHook(() => useTypewriter(setter));
    act(() => {
      result.current.startTyping("hello world");
    });

    raf.drain();
    raf.drain();

    const callsBeforeCancel = setter.mock.calls.length;
    act(() => result.current.cancel());

    let safety = 50;
    while (raf.drain() && safety-- > 0) {
      // ignore — cancel should have removed the queued frame
    }

    expect(setter.mock.calls.length).toBe(callsBeforeCancel);
    expect(setter.mock.calls[callsBeforeCancel - 1][0]).not.toBe("hello world");
  });

  it("re-entrant startTyping cancels the previous drip and starts the new one", () => {
    mockReducedMotion(false);
    const setter = vi.fn<(text: string) => void>();
    const raf = installRafQueue();

    const { result } = renderHook(() => useTypewriter(setter));
    act(() => {
      result.current.startTyping("first prompt");
    });
    raf.drain();
    raf.drain();
    setter.mockClear();

    act(() => {
      result.current.startTyping("second prompt");
    });
    expect(setter).toHaveBeenCalledWith("s"); // synchronous seed for the new drip

    let safety = 500;
    while (raf.drain() && safety-- > 0) {
      // drain
    }

    const calls = setter.mock.calls.map((c) => c[0]);
    expect(calls[calls.length - 1]).toBe("second prompt");
    // None of the post-restart calls should be a prefix of the OLD text
    // (the previous drip is fully cancelled).
    for (const c of calls) {
      expect("second prompt").toMatch(new RegExp("^" + c.replace(/[\s]/g, "\\s")));
    }
  });

  it("unmount cancels in-flight drip so a stale frame does not call a dead setter", () => {
    mockReducedMotion(false);
    const setter = vi.fn<(text: string) => void>();
    const raf = installRafQueue();

    const { result, unmount } = renderHook(() => useTypewriter(setter));
    act(() => {
      result.current.startTyping("hello world");
    });
    raf.drain();

    const callsBeforeUnmount = setter.mock.calls.length;
    unmount();

    let safety = 50;
    while (raf.drain() && safety-- > 0) {
      // drain
    }
    expect(setter.mock.calls.length).toBe(callsBeforeUnmount);
  });
});
