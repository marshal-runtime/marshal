import { act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { render, screen } from "@/test-utils";

import { testDouble } from "../../../../electron/testing/harness";
import { AttachmentPillList } from "./AttachmentPillList";
import type { FileAttachment } from "./ChatInput";

// Stub EntityPill so this suite stays a unit test of the list chrome.
vi.mock("./EntityPill", () => ({
  EntityPill: ({ kind, onRemove }: { kind: { name: string }; onRemove: () => void }) => (
    <div data-testid="attachment-pill" data-name={kind.name}>
      {kind.name}
      <button onClick={onRemove}>remove {kind.name}</button>
    </div>
  ),
}));

// Capture the ResizeObserver callback so tests can trigger resizes manually
let triggerResize: (() => void) | null = null;
const observerDouble = testDouble<ResizeObserver>({
  observe: vi.fn<() => void>(),
  disconnect: vi.fn<() => void>(),
});
vi.stubGlobal(
  "ResizeObserver",
  class {
    constructor(cb: ResizeObserverCallback) {
      triggerResize = () => cb([], observerDouble);
    }
    observe = vi.fn<() => void>();
    disconnect = vi.fn<() => void>();
  },
);

function makeFiles(count: number): FileAttachment[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `file-${i + 1}.docx`,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }));
}

function setWidth(el: Element, width: number) {
  Object.defineProperty(el, "offsetWidth", { get: () => width, configurable: true });
}

/**
 * Sets up measurement widths so the component computes the right visible count,
 * then fires the ResizeObserver callback to trigger recalculation.
 *
 * Uses data-testid attributes to locate measurement elements without direct DOM traversal.
 */
function setupWidths({
  containerWidth,
  pillWidth,
  overflowWidth,
}: {
  containerWidth: number;
  pillWidth: number;
  overflowWidth: number;
}) {
  setWidth(screen.getByTestId("pill-list-container"), containerWidth);
  setWidth(screen.getByTestId("measure-overflow"), overflowWidth);
  within(screen.getByTestId("measure-row"))
    .queryAllByTestId("attachment-pill")
    .forEach((el) => setWidth(el, pillWidth));

  act(() => triggerResize?.());
}

/** Returns pills that are in the actual visible row (not the hidden measurement row). */
function visiblePills() {
  return within(screen.getByTestId("visible-row")).queryAllByTestId("attachment-pill");
}

describe("AttachmentPillList", () => {
  beforeEach(() => {
    triggerResize = null;
  });

  it("renders nothing when files array is empty", () => {
    render(<AttachmentPillList files={[]} onRemove={vi.fn<(index: number) => void>()} />);
    expect(screen.queryByTestId("pill-list-container")).not.toBeInTheDocument();
  });

  it("shows all pills when they all fit in the container", () => {
    render(<AttachmentPillList files={makeFiles(3)} onRemove={vi.fn<(index: number) => void>()} />);

    // container=600, each pill=100, overflow=60 → all 3 fit (300 < 600)
    setupWidths({ containerWidth: 600, pillWidth: 100, overflowWidth: 60 });

    expect(visiblePills()).toHaveLength(3);
    expect(screen.queryByTestId("overflow-pill")).not.toBeInTheDocument();
  });

  it("shows overflow pill when not all pills fit", () => {
    render(<AttachmentPillList files={makeFiles(5)} onRemove={vi.fn<(index: number) => void>()} />);

    // container=400, pill=100, overflow=60
    // i=0: 0+100+(8+60)=168 ≤ 400 → count=1, used=100
    // i=1: 100+8+100+(8+60)=276 ≤ 400 → count=2, used=208
    // i=2: 208+8+100+(8+60)=384 ≤ 400 → count=3, used=316
    // i=3: 316+8+100+(8+60)=492 > 400 → break → visible=3, hidden=2
    setupWidths({ containerWidth: 400, pillWidth: 100, overflowWidth: 60 });

    expect(visiblePills()).toHaveLength(3);
    expect(screen.getByTestId("overflow-pill")).toHaveTextContent("+2");
  });

  it("shows at least 1 pill even when the container is very narrow", () => {
    render(<AttachmentPillList files={makeFiles(4)} onRemove={vi.fn<(index: number) => void>()} />);

    // container=10 — nothing fits normally, but Math.max(1, 0) ensures 1 is shown
    setupWidths({ containerWidth: 10, pillWidth: 200, overflowWidth: 60 });

    expect(visiblePills()).toHaveLength(1);
    expect(screen.getByTestId("overflow-pill")).toHaveTextContent("+3");
  });

  it("shows all pills when only one file is attached", () => {
    render(<AttachmentPillList files={makeFiles(1)} onRemove={vi.fn<(index: number) => void>()} />);

    // Single pill: isLast=true so no overflow space reserved — always fits
    setupWidths({ containerWidth: 0, pillWidth: 0, overflowWidth: 0 });

    expect(visiblePills()).toHaveLength(1);
    expect(screen.queryByTestId("overflow-pill")).not.toBeInTheDocument();
  });

  it("re-computes on container resize (more space → more pills visible)", () => {
    render(<AttachmentPillList files={makeFiles(5)} onRemove={vi.fn<(index: number) => void>()} />);

    // Narrow: only 3 pills visible
    setupWidths({ containerWidth: 400, pillWidth: 100, overflowWidth: 60 });
    expect(visiblePills()).toHaveLength(3);

    // Wider: all 5 fit
    setupWidths({ containerWidth: 800, pillWidth: 100, overflowWidth: 60 });
    expect(visiblePills()).toHaveLength(5);
    expect(screen.queryByTestId("overflow-pill")).not.toBeInTheDocument();
  });

  it("calls onRemove with the correct original file index", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn<(index: number) => void>();
    render(<AttachmentPillList files={makeFiles(5)} onRemove={onRemove} />);

    // 3 visible: file-1, file-2, file-3
    setupWidths({ containerWidth: 400, pillWidth: 100, overflowWidth: 60 });

    // Click the remove button on the second visible pill (file-2, index 1)
    const pills = visiblePills();
    await user.click(within(pills[1]).getByRole("button"));

    expect(onRemove).toHaveBeenCalledWith(1);
  });
});
