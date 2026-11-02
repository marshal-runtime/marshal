import { detectPlatform } from "@tanstack/react-hotkeys";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { useState } from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";

import { HotkeysRoot } from "@/features/hotkeys";
import { act, render, screen } from "@/test-utils";
import type { ContextEntity } from "@/types/electron";

import type { TabId } from "./context-picker-tabs";
import { ContextPickerMenu } from "./ContextPickerMenu";

const noop = () => {};

beforeEach(() => {
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = vi.fn<HTMLElement["scrollIntoView"]>();
  }
});

interface MenuOpts {
  anchorEl?: HTMLElement | null;
  entities?: ContextEntity[];
  isLoading?: boolean;
  isStartSlash?: boolean;
  pickerValue?: string;
  initialTab?: TabId;
  onActiveTabChange?: (tab: TabId) => void;
  onClose?: () => void;
}

function renderWithHotkeys(ui: ReactElement) {
  return render(<HotkeysRoot>{ui}</HotkeysRoot>);
}

function renderMenu(opts: MenuOpts = {}) {
  let activeTab: TabId = opts.initialTab ?? "People";
  function ControlledMenu() {
    const [tab, setTab] = useState<TabId>(opts.initialTab ?? "People");
    activeTab = tab;
    const handleActiveTabChange = (nextTab: TabId) => {
      opts.onActiveTabChange?.(nextTab);
      setTab(nextTab);
    };
    return (
      <ContextPickerMenu
        anchorEl={opts.anchorEl}
        entities={opts.entities ?? []}
        isLoading={opts.isLoading ?? false}
        pickerValue={opts.pickerValue ?? ""}
        activeTab={tab}
        isStartSlash={opts.isStartSlash ?? false}
        onSelect={noop}
        onPickerValueChange={noop}
        onActiveTabChange={handleActiveTabChange}
        onClose={opts.onClose}
      />
    );
  }
  return { ...renderWithHotkeys(<ControlledMenu />), getActiveTab: () => activeTab };
}

const alice: ContextEntity = {
  type: "People",
  id: "p1",
  referenceId: "p1",
  displayName: "Alice",
};
const bob: ContextEntity = {
  type: "People",
  id: "p2",
  referenceId: "p2",
  displayName: "Bob",
};

describe("ContextPickerMenu Ctrl+1..N tab shortcuts", () => {
  it("Ctrl+2 selects the second visible entity tab", async () => {
    const onActiveTabChange = vi.fn<(tab: TabId) => void>();
    const user = userEvent.setup();
    renderMenu({ onActiveTabChange });

    await user.keyboard("{Control>}2{/Control}");

    await vi.waitFor(() => expect(onActiveTabChange).toHaveBeenCalledWith("File"));
  });

  it("ignores shortcuts from external overlays", async () => {
    const onActiveTabChange = vi.fn<(tab: TabId) => void>();
    const user = userEvent.setup();
    renderMenu({ onActiveTabChange });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.tabIndex = -1;
    document.body.append(dialog);

    try {
      dialog.focus();
      await user.keyboard("{Control>}2{/Control}");
    } finally {
      dialog.remove();
    }

    expect(onActiveTabChange).not.toHaveBeenCalled();
  });

  it("Ctrl+3 is ignored when only entity tabs are visible", async () => {
    renderMenu();
    const user = userEvent.setup();
    await user.keyboard("{Control>}3{/Control}");
    expect(screen.getByRole("tab", { name: /people/i })).toHaveAttribute("aria-selected", "true");
  });

  it("Mod+2 selects the Files tab using the platform's primary modifier", async () => {
    const primaryModifier = detectPlatform() === "mac" ? "Meta" : "Control";
    renderMenu();
    const user = userEvent.setup();
    await user.keyboard(`{${primaryModifier}>}2{/${primaryModifier}}`);
    await vi.waitFor(() => {
      expect(screen.getByRole("tab", { name: /files/i })).toHaveAttribute("aria-selected", "true");
    });
    expect(screen.getByRole("tab", { name: /people/i })).toHaveAttribute("aria-selected", "false");
  });

  it("ignores Ctrl+9 (out of range)", async () => {
    renderMenu();
    const user = userEvent.setup();
    await user.keyboard("{Control>}9{/Control}");
    expect(screen.getByRole("tab", { name: /people/i })).toHaveAttribute("aria-selected", "true");
  });

  it("ignores Ctrl+Shift+1 (modifier combo)", async () => {
    renderMenu();
    const user = userEvent.setup();
    await user.keyboard("{Control>}{Shift>}1{/Shift}{/Control}");
    expect(screen.getByRole("tab", { name: /people/i })).toHaveAttribute("aria-selected", "true");
  });

  it("ignores Ctrl+Alt+1 (modifier combo)", async () => {
    const onActiveTabChange = vi.fn<(tab: TabId) => void>();
    const user = userEvent.setup();
    renderMenu({ onActiveTabChange, initialTab: "File" });

    await user.keyboard("{Control>}{Alt>}1{/Alt}{/Control}");

    expect(onActiveTabChange).not.toHaveBeenCalled();
  });

  it("unregisters tab shortcuts on unmount", async () => {
    const onActiveTabChange = vi.fn<(tab: TabId) => void>();
    const user = userEvent.setup();
    const { unmount } = renderMenu({ onActiveTabChange });

    await user.keyboard("{Control>}2{/Control}");
    await vi.waitFor(() => {
      expect(onActiveTabChange).toHaveBeenCalledWith("File");
    });

    unmount();
    onActiveTabChange.mockClear();
    await user.keyboard("{Control>}2{/Control}");
    expect(onActiveTabChange).not.toHaveBeenCalled();
  });

  it("Ctrl+2 still fires when focus is on a picker tab button", async () => {
    const { getActiveTab } = renderMenu();
    const user = userEvent.setup();
    const peopleTab = await screen.findByRole("tab", { name: /people/i });
    act(() => {
      peopleTab.focus();
    });
    expect(peopleTab).toHaveFocus();

    await user.keyboard("{Control>}2{/Control}");
    expect(getActiveTab()).toBe("File");
  });
});

describe("ContextPickerMenu dismissal", () => {
  it("Escape closes the picker", async () => {
    // Picker is now a Radix Popover; Popover's built-in onEscapeKeyDown
    // closes it. (For real-world stacking with a Radix Dialog above the
    // picker, Radix's Dismissable stack defers Escape to the topmost
    // dismissable layer — verified upstream in Radix tests, not re-tested
    // here.)
    const onClose = vi.fn<() => void>();
    const user = userEvent.setup();
    renderMenu({ onClose });
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledWith("escape");
  });

  it("calls onClose when the user clicks outside the menu", async () => {
    const onClose = vi.fn<() => void>();
    const user = userEvent.setup();
    renderWithHotkeys(
      <>
        <ContextPickerMenu
          entities={[]}
          isLoading={false}
          pickerValue=""
          activeTab="People"
          isStartSlash={true}
          onSelect={noop}
          onPickerValueChange={noop}
          onActiveTabChange={noop}
          onClose={onClose}
        />
        <button type="button">Outside</button>
      </>,
    );

    await user.click(screen.getByRole("button", { name: /outside/i }));
    expect(onClose).toHaveBeenCalledWith("outside");
  });

  it("does not close when the user clicks the editor anchor", async () => {
    const onClose = vi.fn<() => void>();
    const user = userEvent.setup();

    function MenuWithAnchor() {
      const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
      return (
        <>
          <button ref={setAnchorEl} type="button">
            Editor anchor
          </button>
          <ContextPickerMenu
            anchorEl={anchorEl}
            entities={[]}
            isLoading={false}
            pickerValue=""
            activeTab="People"
            isStartSlash={true}
            onSelect={noop}
            onPickerValueChange={noop}
            onActiveTabChange={noop}
            onClose={onClose}
          />
        </>
      );
    }

    renderWithHotkeys(<MenuWithAnchor />);
    await user.click(screen.getByRole("button", { name: /editor anchor/i }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not call onClose when the user clicks a tab inside the menu", async () => {
    const onClose = vi.fn<() => void>();
    const user = userEvent.setup();
    renderMenu({ onClose });
    await user.click(screen.getByRole("tab", { name: /people/i }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clicking a tab activates it", async () => {
    // Regression pin: when ContextPickerMenu adopted Radix Tabs, the
    // onMouseDown preventDefault that keeps focus on the Lexical editor
    // also short-circuited Radix's mousedown-based onSelect. We now drive
    // onActiveTabChange ourselves from onMouseDown — this test ensures
    // user clicks continue to switch tabs.
    const { getActiveTab } = renderMenu();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /files/i }));
    expect(getActiveTab()).toBe("File");
  });
});

describe("ContextPickerMenu anchoring", () => {
  it("does not render content when an explicit anchor is not ready", () => {
    renderMenu({ anchorEl: null });
    expect(screen.queryByTestId("context-picker-menu")).toBeNull();
  });
});

describe("ContextPickerMenu tab styling", () => {
  it("does not inherit the generic shadcn trigger outline or offset indicator styles", () => {
    renderMenu();

    const peopleTab = screen.getByRole("tab", { name: /people/i });
    const className = peopleTab.getAttribute("class") ?? "";

    expect(className).not.toContain("border-transparent");
    expect(className).not.toContain("focus-visible:border-ring");
    expect(className).not.toContain("focus-visible:ring-[3px]");
    expect(className).not.toContain("focus-visible:outline-1");
    expect(className).not.toContain("group-data-horizontal/tabs:after:bottom-[-5px]");
  });
});

describe("ContextPickerMenu states", () => {
  it("renders skeleton rows while loading with no entities", () => {
    renderMenu({ isLoading: true });
    expect(screen.getAllByTestId("context-picker-skeleton-row").length).toBe(5);
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("renders an empty-state message when search returned nothing", () => {
    renderMenu({ isLoading: false });
    expect(screen.getByText("No results found")).toBeInTheDocument();
  });

  it("renders entity options as listbox children", () => {
    renderMenu({ entities: [alice, bob] });
    expect(screen.getByRole("option", { name: /alice/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /bob/i })).toBeInTheDocument();
  });

  it("highlights the controlled pickerValue", () => {
    renderMenu({ entities: [alice, bob], pickerValue: "People:p2" });
    const bobOption = screen.getByRole("option", { name: /bob/i });
    expect(bobOption).toHaveAttribute("data-selected", "true");
    expect(bobOption).toHaveAttribute("aria-selected", "true");
  });

  it("scrolls the externally selected item into view when pickerValue changes", async () => {
    const menuProps = {
      entities: [alice, bob],
      isLoading: false,
      activeTab: "People" as const,
      isStartSlash: true,
      onSelect: noop,
      onPickerValueChange: noop,
      onActiveTabChange: noop,
    };
    const { rerender } = renderWithHotkeys(
      <ContextPickerMenu {...menuProps} pickerValue="People:p1" />,
    );

    await vi.waitFor(() => {
      expect(screen.getByRole("option", { name: /alice/i })).toHaveAttribute(
        "data-selected",
        "true",
      );
    });
    const bobOption = screen.getByRole("option", { name: /bob/i });
    const bobScrollSpy = vi.spyOn(bobOption, "scrollIntoView").mockImplementation(() => {});

    try {
      rerender(
        <HotkeysRoot>
          <ContextPickerMenu {...menuProps} pickerValue="People:p2" />
        </HotkeysRoot>,
      );

      await vi.waitFor(() => {
        expect(bobOption).toHaveAttribute("data-selected", "true");
        expect(bobScrollSpy).toHaveBeenCalledWith({ block: "nearest" });
      });
    } finally {
      bobScrollSpy.mockRestore();
    }
  });

  it("does not scroll external selection before an explicit anchor is placed", async () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const getBoundingClientRectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const anchor = document.createElement("button");
    let restoreBobScrollSpy: (() => void) | undefined;
    document.body.append(anchor);

    getBoundingClientRectSpy.mockImplementation(function getBoundingClientRect(this: HTMLElement) {
      if (this === anchor) {
        return DOMRect.fromRect({ x: 100, y: 100, width: 200, height: 40 });
      }
      if (this instanceof HTMLElement && this.dataset.contextPickerMenu === "true") {
        return DOMRect.fromRect({ x: 0, y: 0, width: 80, height: 240 });
      }
      return originalGetBoundingClientRect.call(this);
    });

    try {
      const menuProps = {
        anchorEl: anchor,
        entities: [alice, bob],
        isLoading: false,
        activeTab: "People" as const,
        isStartSlash: true,
        onSelect: noop,
        onPickerValueChange: noop,
        onActiveTabChange: noop,
      };
      const { rerender, unmount } = renderWithHotkeys(
        <ContextPickerMenu {...menuProps} pickerValue="People:p1" />,
      );

      await vi.waitFor(() => {
        const aliceOption = screen
          .getAllByRole("option", { hidden: true })
          .find((option) => option.getAttribute("data-value") === "People:p1");
        expect(aliceOption).toHaveAttribute("data-selected", "true");
      });
      const targetBobOption = screen
        .getAllByRole("option", { hidden: true })
        .find((option) => option.getAttribute("data-value") === "People:p2");
      if (!(targetBobOption instanceof HTMLElement)) {
        throw new Error("Expected Bob option to be rendered before rerender");
      }
      const bobScrollSpy = vi.spyOn(targetBobOption, "scrollIntoView").mockImplementation(() => {});
      restoreBobScrollSpy = () => bobScrollSpy.mockRestore();
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

      rerender(
        <HotkeysRoot>
          <ContextPickerMenu pickerValue="People:p2" {...menuProps} />
        </HotkeysRoot>,
      );

      await vi.waitFor(() => {
        const selectedBobOption = screen
          .getAllByRole("option", { hidden: true })
          .find((option) => option.getAttribute("data-value") === "People:p2");
        expect(selectedBobOption).toHaveAttribute("data-selected", "true");
      });
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

      expect(bobScrollSpy).not.toHaveBeenCalled();
      unmount();
    } finally {
      anchor.remove();
      restoreBobScrollSpy?.();
      getBoundingClientRectSpy.mockRestore();
    }
  });
});

describe("ContextPickerMenu accessibility", () => {
  it("exposes a listbox role inside the menu", () => {
    renderMenu({ entities: [alice] });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("renders deterministic listbox and option ids from picker values", () => {
    renderMenu({ entities: [alice, bob], pickerValue: "People:p2" });

    expect(screen.getByRole("listbox")).toHaveAttribute("id", "context-picker-listbox");
    expect(screen.getByRole("option", { name: /alice/i })).toHaveAttribute(
      "id",
      "context-picker-option-People%3Ap1",
    );
    expect(screen.getByRole("option", { name: /bob/i })).toHaveAttribute(
      "id",
      "context-picker-option-People%3Ap2",
    );
  });

  it("renders deterministic option ids for Skills tab", async () => {
    const testSkill = {
      id: "review",
      name: "review",
      description: "Review code",
      instructions: "Review code",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      scope: "local" as const,
    };

    function SkillsMenuWithTab() {
      const [tab, setTab] = useState<TabId>("Skills");
      return (
        <ContextPickerMenu
          entities={[]}
          isLoading={false}
          pickerValue="review"
          activeTab={tab}
          isStartSlash={true}
          filteredSkills={[testSkill]}
          slashQuery=""
          onSelect={noop}
          onPickerValueChange={noop}
          onActiveTabChange={setTab}
          onSelectSkill={noop}
          onClose={noop}
        />
      );
    }

    renderWithHotkeys(<SkillsMenuWithTab />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /skills/i }));

    const skillOption = await screen.findByRole("option", { name: /\/review/i });
    expect(skillOption).toHaveAttribute("id", "context-picker-option-review");
  });
});
