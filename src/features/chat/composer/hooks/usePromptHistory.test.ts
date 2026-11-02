// Marshal-owned module.
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { usePromptHistory, MAX_HISTORY } from "./usePromptHistory";

function setup(history: string[] = []) {
  const setInput = vi.fn<(value: string) => void>();
  const { result, rerender } = renderHook(
    ({ h }: { h: string[] }) => usePromptHistory(h, setInput),
    { initialProps: { h: history } },
  );
  return { result, setInput, rerender: (h: string[]) => rerender({ h }) };
}

describe("usePromptHistory", () => {
  describe("handleArrowAtBoundary", () => {
    it("returns false on ArrowUp when history is empty", () => {
      const { result, setInput } = setup([]);
      expect(result.current.handleArrowAtBoundary("up", "")).toBe(false);
      expect(setInput).not.toHaveBeenCalled();
    });

    it("ArrowUp recalls the last entry", async () => {
      const { result, setInput } = setup(["first message"]);
      await act(() => result.current.handleArrowAtBoundary("up", ""));
      expect(setInput).toHaveBeenCalledWith("first message");
    });

    it("ArrowUp navigates backward through multiple entries", async () => {
      const { result, setInput } = setup(["first", "second"]);
      await act(() => result.current.handleArrowAtBoundary("up", ""));
      expect(setInput).toHaveBeenLastCalledWith("second");
      await act(() => result.current.handleArrowAtBoundary("up", ""));
      expect(setInput).toHaveBeenLastCalledWith("first");
      // Already at oldest - returns true (consumed) but no further setInput
      setInput.mockClear();
      await act(() => result.current.handleArrowAtBoundary("up", ""));
      expect(setInput).not.toHaveBeenCalled();
    });

    it("ArrowDown after ArrowUp restores the saved draft", async () => {
      const { result, setInput } = setup(["hello"]);
      await act(() => result.current.handleArrowAtBoundary("up", "my draft"));
      setInput.mockClear();
      await act(() => result.current.handleArrowAtBoundary("down", "hello"));
      expect(setInput).toHaveBeenCalledWith("my draft");
    });

    it("ArrowDown returns false when not navigating", () => {
      const { result, setInput } = setup(["hello"]);
      expect(result.current.handleArrowAtBoundary("down", "current")).toBe(false);
      expect(setInput).not.toHaveBeenCalled();
    });

    it(`respects MAX_HISTORY cap - navigation stops at the capped oldest entry`, async () => {
      const full = Array.from({ length: MAX_HISTORY + 5 }, (_, i) => `prompt ${i + 1}`);
      const { result, setInput } = setup(full.slice(-MAX_HISTORY));
      await act(() => result.current.handleArrowAtBoundary("up", ""));
      expect(setInput).toHaveBeenLastCalledWith(`prompt ${MAX_HISTORY + 5}`);
      for (let i = 0; i < MAX_HISTORY - 1; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential test steps
        await act(() => result.current.handleArrowAtBoundary("up", ""));
      }
      expect(setInput).toHaveBeenLastCalledWith("prompt 6");
    });

    it("history updates from outside are reflected in navigation", async () => {
      const { result, setInput, rerender } = setup(["first"]);
      rerender(["first", "second"]);
      await act(() => result.current.handleArrowAtBoundary("up", ""));
      expect(setInput).toHaveBeenCalledWith("second");
    });
  });

  describe("handleEscape", () => {
    it("Escape while navigating history restores the saved draft", async () => {
      const { result, setInput } = setup(["history item"]);
      await act(() => result.current.handleArrowAtBoundary("up", "my draft"));
      setInput.mockClear();
      let consumed = false;
      act(() => {
        consumed = result.current.handleEscape();
      });
      expect(consumed).toBe(true);
      expect(setInput).toHaveBeenCalledWith("my draft");
    });

    it("Escape outside of history navigation is a no-op", () => {
      const { result, setInput } = setup(["history item"]);
      expect(result.current.handleEscape()).toBe(false);
      expect(setInput).not.toHaveBeenCalled();
    });
  });

  describe("clearHistory", () => {
    it("resets mid-navigation state so ArrowDown does nothing after clear", async () => {
      const { result, setInput } = setup(["first"]);
      await act(() => result.current.handleArrowAtBoundary("up", ""));
      act(() => result.current.clearHistory());
      setInput.mockClear();
      const consumed = result.current.handleArrowAtBoundary("down", "");
      expect(consumed).toBe(false);
      expect(setInput).not.toHaveBeenCalled();
    });

    it("is stable across renders (useCallback)", () => {
      const { result, rerender } = renderHook(
        ({ h }) => usePromptHistory(h, vi.fn<(value: string) => void>()),
        {
          initialProps: { h: [] as string[] },
        },
      );
      const ref1 = result.current.clearHistory;
      rerender({ h: [] });
      expect(result.current.clearHistory).toBe(ref1);
    });

    it("handleArrowAtBoundary is stable across renders (useCallback)", () => {
      const { result, rerender } = renderHook(
        ({ h }) => usePromptHistory(h, vi.fn<(value: string) => void>()),
        {
          initialProps: { h: [] as string[] },
        },
      );
      const ref1 = result.current.handleArrowAtBoundary;
      rerender({ h: ["new"] });
      expect(result.current.handleArrowAtBoundary).toBe(ref1);
    });
  });
});
