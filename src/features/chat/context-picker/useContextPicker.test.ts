import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ContextEntity } from "@/types/electron";

import { detectTrigger, useContextPicker } from "./useChatContextPicker";

type OnPickEntity = (entity: ContextEntity, triggerLength: number) => void;

function makePersonEntity(): ContextEntity {
  return {
    type: "People",
    id: "p1",
    referenceId: "p1",
    displayName: "Alice Example",
    email: "alice@example.com",
  };
}

describe("detectTrigger", () => {
  it("detects slash at the start as a Skills trigger", () => {
    expect(detectTrigger("/sum")).toEqual({
      active: true,
      query: "sum",
      triggerIndex: 0,
      isStartSlash: true,
      trigger: "/",
    });
  });

  it("detects slash after whitespace", () => {
    expect(detectTrigger("hello /alice")).toEqual({
      active: true,
      query: "alice",
      triggerIndex: 6,
      isStartSlash: true,
      trigger: "/",
    });
  });

  it("detects @ as a local-file trigger", () => {
    expect(detectTrigger("use @report")).toEqual({
      active: true,
      query: "report",
      triggerIndex: 4,
      isStartSlash: false,
      trigger: "@",
    });
  });

  it("does not trigger once the slash query contains whitespace", () => {
    expect(detectTrigger("/alice done").active).toBe(false);
  });
});

describe("useContextPicker", () => {
  it("opens @ mentions on the Files tab", () => {
    const { result } = renderHook(() =>
      useContextPicker({ value: "use @report", onPickEntity: vi.fn<OnPickEntity>() }),
    );
    expect(result.current.active).toBe(true);
    expect(result.current.activeTab).toBe("File");
  });

  it("suppresses re-opening after Escape until the input changes", () => {
    const onPickEntity = vi.fn<OnPickEntity>();
    const { result, rerender } = renderHook(
      ({ value }) => useContextPicker({ value, onPickEntity }),
      { initialProps: { value: "hello /ali" } },
    );

    expect(result.current.active).toBe(true);
    act(() => result.current.handleClose());
    expect(result.current.active).toBe(false);

    rerender({ value: "hello /ali" });
    expect(result.current.active).toBe(false);

    rerender({ value: "hello /alic" });
    expect(result.current.active).toBe(true);
  });

  it("activate opens the picker without a slash trigger", () => {
    const { result } = renderHook(() =>
      useContextPicker({ value: "plain text", onPickEntity: vi.fn<OnPickEntity>() }),
    );

    expect(result.current.active).toBe(false);
    act(() => result.current.activate());
    expect(result.current.active).toBe(true);
    expect(result.current.query).toBe("");
    expect(result.current.triggerLength).toBe(0);
  });

  it("activate(tab) synchronously sets the requested active tab", () => {
    const { result } = renderHook(() =>
      useContextPicker({ value: "", onPickEntity: vi.fn<OnPickEntity>() }),
    );
    act(() => {
      result.current.activate("File");
    });
    expect(result.current.active).toBe(true);
    expect(result.current.activeTab).toBe("File");
  });

  it("selecting an entity closes the picker immediately for the current input", () => {
    const onPickEntity = vi.fn<OnPickEntity>();
    const { result, rerender } = renderHook(
      ({ value }) => useContextPicker({ value, onPickEntity }),
      { initialProps: { value: "hello /ali" } },
    );

    expect(result.current.active).toBe(true);

    act(() => result.current.handleSelect(makePersonEntity()));

    expect(onPickEntity).toHaveBeenCalledWith(makePersonEntity(), 4);
    expect(result.current.active).toBe(false);

    rerender({ value: "hello /ali" });
    expect(result.current.active).toBe(false);

    rerender({ value: "hello Alice Example " });
    expect(result.current.active).toBe(false);
  });

  it("opens again when a fresh slash matches a previously selected entity trigger", () => {
    const onPickEntity = vi.fn<OnPickEntity>();
    const { result, rerender } = renderHook(
      ({ value }) => useContextPicker({ value, onPickEntity }),
      { initialProps: { value: "/" } },
    );

    expect(result.current.active).toBe(true);

    act(() => result.current.handleSelect(makePersonEntity()));
    expect(result.current.active).toBe(false);

    rerender({ value: "Alice Example " });
    expect(result.current.active).toBe(false);

    rerender({ value: "" });
    expect(result.current.active).toBe(false);

    rerender({ value: "/" });
    expect(result.current.active).toBe(true);
    expect(result.current.activeTab).toBe("Skills");
  });

  it("re-trigger after consecutive activate() calls applies the trigger's default tab", () => {
    // Regression pin (was: "activate() while already active does not strand
    // programmaticActivationRef for the next trigger") — the ref no longer
    // exists, but the user-observable contract is unchanged: after
    // activate(...) twice → handleClose → typing "/", the picker opens on
    // the start-slash default ("Skills").
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) =>
        useContextPicker({ value, onPickEntity: vi.fn<OnPickEntity>() }),
      { initialProps: { value: "" } },
    );

    // 1) Open via activate (programmatic). Picker becomes active; tab → "File".
    act(() => {
      result.current.activate("File");
    });
    expect(result.current.active).toBe(true);
    expect(result.current.activeTab).toBe("File");

    // 2) Call activate AGAIN while still active.
    act(() => {
      result.current.activate("People");
    });
    expect(result.current.activeTab).toBe("People");

    // 3) Close the picker.
    act(() => {
      result.current.handleClose();
    });
    expect(result.current.active).toBe(false);

    // 4) Re-open via TRIGGER (typing "/"). The default-tab branch must
    // fire and set the tab to the start-slash default.
    rerender({ value: "/" });
    expect(result.current.active).toBe(true);
    expect(result.current.activeTab).toBe("Skills");
  });
});
