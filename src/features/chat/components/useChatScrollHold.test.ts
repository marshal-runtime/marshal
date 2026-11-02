import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { isTranscriptHeld, setTranscriptHeld } from "../state/messageWindow";
import { useChatScrollHold } from "./useChatScrollHold";

const SESSION = "session-1";

function scroller(scrollTop: number, scrollHeight: number): HTMLElement {
  const element = document.createElement("div");
  element.style.overflowY = "auto";
  Object.defineProperty(element, "clientHeight", { value: 500, configurable: true });
  Object.defineProperty(element, "scrollHeight", { value: scrollHeight, configurable: true });
  element.scrollTop = scrollTop;
  return element;
}

function wheel(element: HTMLElement, deltaY: number, target: Element = element) {
  return { currentTarget: element, target, deltaY };
}

describe("useChatScrollHold", () => {
  afterEach(() => setTranscriptHeld(SESSION, false));

  it("follows the bottom until the reader scrolls up", () => {
    const { result } = renderHook(() => useChatScrollHold(SESSION));
    const element = scroller(1500, 2000);

    expect(result.current.targetScrollTop(1499, { scrollElement: element })).toBe(1499);
    result.current.handleScroll(element);
    result.current.handleScroll(scroller(1300, 2000));

    expect(isTranscriptHeld(SESSION)).toBe(true);
    expect(result.current.targetScrollTop(1499, { scrollElement: element })).toBe(1500);
  });

  it("does not start a hold when a shrink clamps the scroll position", () => {
    const { result } = renderHook(() => useChatScrollHold(SESSION));

    result.current.handleScroll(scroller(1500, 2000));
    result.current.handleScroll(scroller(1000, 1500));

    expect(isTranscriptHeld(SESSION)).toBe(false);
  });

  it("does not end a hold when layout moves the reader near the bottom", () => {
    const { result } = renderHook(() => useChatScrollHold(SESSION));
    const element = scroller(1000, 2000);

    result.current.handleWheel(wheel(element, -100));
    result.current.handleScroll(element);
    expect(result.current.handleScroll(scroller(1000, 1500))).toBe(false);

    expect(isTranscriptHeld(SESSION)).toBe(true);
  });

  it("stays held while scrolling down short of the bottom, then ends at the bottom", () => {
    const { result } = renderHook(() => useChatScrollHold(SESSION));

    result.current.handleWheel(wheel(scroller(1000, 2000), -100));
    result.current.handleScroll(scroller(1000, 2000));

    expect(result.current.handleScroll(scroller(1400, 2000))).toBe(false);
    expect(isTranscriptHeld(SESSION)).toBe(true);

    expect(result.current.handleScroll(scroller(1490, 2000))).toBe(true);
    expect(isTranscriptHeld(SESSION)).toBe(false);
  });

  it("ends a hold on a downward wheel when a shrink already left the reader at the bottom", () => {
    const { result } = renderHook(() => useChatScrollHold(SESSION));
    const clamped = scroller(1500, 2000);

    result.current.handleWheel(wheel(clamped, -100));

    expect(result.current.handleWheel(wheel(clamped, 100))).toBe(true);
    expect(isTranscriptHeld(SESSION)).toBe(false);
  });

  it("ignores wheel events that belong to a nested scroller", () => {
    const { result } = renderHook(() => useChatScrollHold(SESSION));
    const element = scroller(1000, 2000);
    const nested = scroller(100, 900);
    element.append(nested);
    document.body.append(element);

    result.current.handleWheel(wheel(element, -100, nested));

    expect(isTranscriptHeld(SESSION)).toBe(false);
    element.remove();
  });

  it("clears the hold when the session changes", () => {
    const { result, rerender } = renderHook(({ id }) => useChatScrollHold(id), {
      initialProps: { id: SESSION },
    });

    result.current.handleWheel(wheel(scroller(1000, 2000), -100));
    expect(isTranscriptHeld(SESSION)).toBe(true);

    rerender({ id: "session-2" });

    expect(isTranscriptHeld(SESSION)).toBe(false);
  });
});
