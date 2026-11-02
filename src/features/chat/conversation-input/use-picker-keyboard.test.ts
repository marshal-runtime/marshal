import { renderHook } from "@testing-library/react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import type { TabId } from "../context-picker/context-picker-tabs";
import { usePickerKeyboard, type PickerVisibleItem } from "./use-picker-keyboard";

function makeItem(id: string): PickerVisibleItem & { commit: ReturnType<typeof vi.fn> } {
  const commit = vi.fn<() => void>();
  return { id, commit };
}

function setup(overrides: Partial<Parameters<typeof usePickerKeyboard>[0]> = {}) {
  const onClose = vi.fn<() => void>();
  const setPickerValue = vi.fn<(value: string) => void>();
  const setActiveTab = vi.fn<(tab: TabId) => void>();

  const { result } = renderHook(() =>
    usePickerKeyboard({
      active: true,
      activeTab: "People",
      visibleTabs: ["People", "File"],
      visibleItems: [],
      pickerValue: "",
      setPickerValue,
      setActiveTab,
      onClose,
      ...overrides,
    }),
  );

  return { result, onClose, setPickerValue, setActiveTab };
}

function keyEvent(key: string) {
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the hook only reads key/preventDefault from React's keyboard event surface.
  return {
    key,
    preventDefault: vi.fn<() => void>(),
  } as unknown as ReactKeyboardEvent<HTMLDivElement>;
}

// Generate fresh mock items per call so each test starts with un-called mocks.
function peopleItems(): (PickerVisibleItem & { commit: ReturnType<typeof vi.fn> })[] {
  return [makeItem("A"), makeItem("B")];
}

describe("usePickerKeyboard.onPickerKeyIntercept", () => {
  it("Escape closes the picker and reports as handled when active", () => {
    const { result, onClose } = setup({ active: true });
    const handled = result.current.onPickerKeyIntercept("Escape");
    expect(handled).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape is a no-op when picker is inactive", () => {
    const { result, onClose } = setup({ active: false });
    const handled = result.current.onPickerKeyIntercept("Escape");
    expect(handled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Enter without items does not close or select", () => {
    const aCommit = vi.fn<() => void>();
    const { result, onClose } = setup({ visibleItems: [] });
    const handled = result.current.onPickerKeyIntercept("Enter");
    expect(handled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(aCommit).not.toHaveBeenCalled();
  });

  it("ArrowUp is intercepted when picker is active (with items)", () => {
    const { result } = setup({ active: true, visibleItems: peopleItems() });
    expect(result.current.onPickerKeyIntercept("ArrowUp")).toBe(true);
  });

  it("ArrowDown is intercepted when picker is active (with items)", () => {
    const { result } = setup({ active: true, visibleItems: peopleItems() });
    expect(result.current.onPickerKeyIntercept("ArrowDown")).toBe(true);
  });

  it("ArrowUp is intercepted when picker is active even with zero items", () => {
    // Suppress prompt history navigation regardless of result count — if the
    // picker is open, the user wants the picker.
    const { result } = setup({ active: true, visibleItems: [] });
    expect(result.current.onPickerKeyIntercept("ArrowUp")).toBe(true);
  });

  it("ArrowUp is NOT intercepted when picker is inactive", () => {
    const { result } = setup({ active: false });
    expect(result.current.onPickerKeyIntercept("ArrowUp")).toBe(false);
  });

  it("ArrowDown is NOT intercepted when picker is inactive", () => {
    const { result } = setup({ active: false });
    expect(result.current.onPickerKeyIntercept("ArrowDown")).toBe(false);
  });
});

describe("usePickerKeyboard.handleKeyDown", () => {
  it("ArrowDown advances the highlighted value (wraps)", () => {
    const { result, setPickerValue } = setup({
      visibleItems: peopleItems(),
      pickerValue: "B",
    });

    expect(result.current.handleKeyDown(keyEvent("ArrowDown"))).toBe(true);
    expect(setPickerValue).toHaveBeenCalledWith("A");
  });

  it("ArrowUp from the first item wraps to the last", () => {
    const { result, setPickerValue } = setup({
      visibleItems: peopleItems(),
      pickerValue: "A",
    });

    expect(result.current.handleKeyDown(keyEvent("ArrowUp"))).toBe(true);
    expect(setPickerValue).toHaveBeenCalledWith("B");
  });

  it("Enter commits the highlighted item", () => {
    const items = peopleItems();
    const { result } = setup({ visibleItems: items, pickerValue: "B" });
    const event = keyEvent("Enter");

    expect(result.current.handleKeyDown(event)).toBe(true);
    expect(items[1].commit).toHaveBeenCalledTimes(1);
    expect(items[0].commit).not.toHaveBeenCalled();
  });

  it("Enter with empty pickerValue is a no-op", () => {
    // PickerController pre-seeds pickerValue to the first visible item
    // before the picker is shown to the user, so empty pickerValue with
    // items present is a transient state we deliberately don't act on
    // (cmdk's controlled value is empty → no row is highlighted →
    // nothing to commit).
    const items = peopleItems();
    const { result } = setup({ visibleItems: items, pickerValue: "" });

    expect(result.current.handleKeyDown(keyEvent("Enter"))).toBe(true);
    expect(items[0].commit).not.toHaveBeenCalled();
    expect(items[1].commit).not.toHaveBeenCalled();
  });

  it("dedupes Enter already handled by Lexical command interception", () => {
    const items = peopleItems();
    const { result } = setup({ visibleItems: items, pickerValue: "A" });

    expect(result.current.onPickerKeyIntercept("Enter")).toBe(true);
    expect(items[0].commit).toHaveBeenCalledTimes(1);

    const event = keyEvent("Enter");
    expect(result.current.handleKeyDown(event)).toBe(true);
    // Dedup: the React handler must NOT re-commit on the same key event.
    expect(items[0].commit).toHaveBeenCalledTimes(1);
  });

  it("Tab commits the highlighted item (Lexical-intercepted path)", () => {
    const items = peopleItems();
    const { result } = setup({ visibleItems: items, pickerValue: "B" });

    expect(result.current.onPickerKeyIntercept("Tab")).toBe(true);
    expect(items[1].commit).toHaveBeenCalledTimes(1);
  });

  it("Tab commits via handleKeyDown when not pre-intercepted by Lexical", () => {
    const items = peopleItems();
    const { result } = setup({ visibleItems: items, pickerValue: "A" });
    const event = keyEvent("Tab");

    expect(result.current.handleKeyDown(event)).toBe(true);
    expect(items[0].commit).toHaveBeenCalledTimes(1);
  });
});

describe("usePickerKeyboard Skills tab", () => {
  it("Enter on Skills tab commits the highlighted skill", () => {
    const skillA = makeItem("summarize");
    const skillB = makeItem("translate");
    const { result } = setup({
      activeTab: "Skills",
      visibleItems: [skillA, skillB],
      pickerValue: "translate",
    });
    const event = keyEvent("Enter");

    expect(result.current.handleKeyDown(event)).toBe(true);
    expect(skillB.commit).toHaveBeenCalledTimes(1);
    expect(skillA.commit).not.toHaveBeenCalled();
  });

  it("Tab on Skills tab also commits the skill", () => {
    const skillA = makeItem("summarize");
    const { result } = setup({
      activeTab: "Skills",
      visibleItems: [skillA],
      pickerValue: "summarize",
    });

    expect(result.current.onPickerKeyIntercept("Tab")).toBe(true);
    expect(skillA.commit).toHaveBeenCalledTimes(1);
  });

  it("Skills tab is a no-op when visibleItems is empty", () => {
    const { result } = setup({
      activeTab: "Skills",
      visibleItems: [],
    });
    expect(result.current.onPickerKeyIntercept("Enter")).toBe(false);
  });
});

describe("usePickerKeyboard tab cycling (ArrowLeft / ArrowRight)", () => {
  it("ArrowRight advances to the next visible tab", () => {
    const { result, setActiveTab } = setup({
      visibleTabs: ["People", "File"],
      activeTab: "People",
    });

    expect(result.current.handleKeyDown(keyEvent("ArrowRight"))).toBe(true);
    expect(setActiveTab).toHaveBeenCalledWith("File");
  });

  it("ArrowRight wraps from the last tab back to the first", () => {
    const { result, setActiveTab } = setup({
      visibleTabs: ["People", "File"],
      activeTab: "File",
    });

    expect(result.current.handleKeyDown(keyEvent("ArrowRight"))).toBe(true);
    expect(setActiveTab).toHaveBeenCalledWith("People");
  });

  it("ArrowLeft wraps from the first tab to the last", () => {
    const { result, setActiveTab } = setup({
      visibleTabs: ["People", "File"],
      activeTab: "People",
    });

    expect(result.current.handleKeyDown(keyEvent("ArrowLeft"))).toBe(true);
    expect(setActiveTab).toHaveBeenCalledWith("File");
  });

  it("falls back to the first tab when activeTab is not in visibleTabs", () => {
    // Reproduces the transient `isStartSlash` flip case the production code
    // guards against with `currentIdx < 0 ? 0 : currentIdx`.
    const { result, setActiveTab } = setup({
      visibleTabs: ["People", "File"],
      activeTab: "Skills",
    });

    expect(result.current.handleKeyDown(keyEvent("ArrowRight"))).toBe(true);
    // baseIdx falls back to 0 (People), delta=+1 → File
    expect(setActiveTab).toHaveBeenCalledWith("File");
  });

  it("does not cycle when only one tab is visible", () => {
    const { result, setActiveTab } = setup({
      visibleTabs: ["People"],
      activeTab: "People",
    });

    // Production guard: `if (visibleTabs.length > 1 && ...)` — should be a no-op.
    expect(result.current.handleKeyDown(keyEvent("ArrowRight"))).toBe(false);
    expect(setActiveTab).not.toHaveBeenCalled();
  });
});
