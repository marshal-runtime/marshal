import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useMessageQueue } from "./useMessageQueue";

describe("useMessageQueue", () => {
  it("enqueues messages in FIFO order for the active session", () => {
    const { result } = renderHook(() => useMessageQueue("s1"));

    act(() => {
      result.current.enqueue("s1", "first", []);
      result.current.enqueue("s1", "second", []);
    });

    expect(result.current.queue.map((q) => q.text)).toEqual(["first", "second"]);
  });

  it("assigns a unique id to each item", () => {
    const { result } = renderHook(() => useMessageQueue("s1"));
    act(() => {
      result.current.enqueue("s1", "a", []);
      result.current.enqueue("s1", "b", []);
    });
    const [a, b] = result.current.queue;
    expect(a.id).not.toBe(b.id);
  });

  it("removes a specific item by id", () => {
    const { result } = renderHook(() => useMessageQueue("s1"));
    let firstId = "";
    act(() => {
      firstId = result.current.enqueue("s1", "first", []).id;
      result.current.enqueue("s1", "second", []);
    });
    act(() => {
      result.current.removeItem("s1", firstId);
    });
    expect(result.current.queue.map((q) => q.text)).toEqual(["second"]);
  });

  it("isolates queues per session (no cross-session drain)", () => {
    const { result, rerender } = renderHook(({ sid }) => useMessageQueue(sid), {
      initialProps: { sid: "s1" as string | null },
    });

    act(() => {
      result.current.enqueue("s1", "for s1", []);
      result.current.enqueue("s2", "for s2", []);
    });

    // Active session s1 only sees its own item.
    expect(result.current.queue.map((q) => q.text)).toEqual(["for s1"]);

    rerender({ sid: "s2" });
    expect(result.current.queue.map((q) => q.text)).toEqual(["for s2"]);
  });

  it("clears all items for a session", () => {
    const { result } = renderHook(() => useMessageQueue("s1"));
    act(() => {
      result.current.enqueue("s1", "a", []);
      result.current.enqueue("s1", "b", []);
    });
    act(() => {
      result.current.clearSession("s1");
    });
    expect(result.current.queue).toEqual([]);
  });

  it("returns an empty queue for a null session", () => {
    const { result } = renderHook(() => useMessageQueue(null));
    expect(result.current.queue).toEqual([]);
  });
});
