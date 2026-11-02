// marshal-owned renderer test
import { within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { render, screen, waitFor } from "@/test-utils";

import { AttachmentPillList } from "./AttachmentPillList";
import type { FileAttachment } from "./ChatInput";

const PILL_WIDTH = 100;

// Fixed-width pill mock so layout math is predictable regardless of font rendering.
vi.mock("./EntityPill", () => ({
  EntityPill: ({ kind, onRemove }: { kind: { name: string }; onRemove: () => void }) => (
    <div
      data-testid="attachment-pill"
      data-name={kind.name}
      style={{ width: `${PILL_WIDTH}px`, display: "block", flexShrink: 0 }}
    >
      {kind.name}
      <button onClick={onRemove}>remove {kind.name}</button>
    </div>
  ),
}));

function makeFiles(count: number): FileAttachment[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `file-${i + 1}.docx`,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }));
}

/** Returns pills in the visible row only. */
function visiblePills() {
  return within(screen.getByTestId("visible-row")).queryAllByTestId("attachment-pill");
}

/** Sets the container width and waits for ResizeObserver to fire. */
async function setContainerWidth(px: number) {
  screen.getByTestId("pill-list-container").style.width = `${px}px`;
  // Give the real ResizeObserver a tick to fire and React to re-render.
  await new Promise((r) => setTimeout(r, 50));
}

describe("AttachmentPillList (browser)", () => {
  it("renders nothing when files array is empty", () => {
    render(<AttachmentPillList files={[]} onRemove={vi.fn<(index: number) => void>()} />);
    expect(screen.queryByTestId("pill-list-container")).not.toBeInTheDocument();
  });

  it("shows all pills when they all fit in the container", async () => {
    render(<AttachmentPillList files={makeFiles(3)} onRemove={vi.fn<(index: number) => void>()} />);

    // 3 pills × 100px + 2 gaps × 8px = 316px — use 600px so all fit
    await setContainerWidth(600);

    await waitFor(() => expect(visiblePills()).toHaveLength(3));
    expect(screen.queryByTestId("overflow-pill")).not.toBeInTheDocument();
  });

  it("shows overflow pill when not all pills fit", async () => {
    render(<AttachmentPillList files={makeFiles(5)} onRemove={vi.fn<(index: number) => void>()} />);

    // 400px: fits 3 pills (300px) + gaps but not 4 once overflow pill is reserved
    await setContainerWidth(400);

    await waitFor(() => {
      expect(visiblePills()).toHaveLength(3);
      expect(screen.getByTestId("overflow-pill")).toBeInTheDocument();
    });
  });

  it("shows at least 1 pill even when the container is very narrow", async () => {
    render(<AttachmentPillList files={makeFiles(4)} onRemove={vi.fn<(index: number) => void>()} />);

    await setContainerWidth(10);

    await waitFor(() => {
      expect(visiblePills()).toHaveLength(1);
      expect(screen.getByTestId("overflow-pill")).toHaveTextContent("+3");
    });
  });

  it("shows all pills when only one file is attached", async () => {
    render(<AttachmentPillList files={makeFiles(1)} onRemove={vi.fn<(index: number) => void>()} />);

    // Single pill is always shown regardless of container width
    await setContainerWidth(50);

    await waitFor(() => expect(visiblePills()).toHaveLength(1));
    expect(screen.queryByTestId("overflow-pill")).not.toBeInTheDocument();
  });

  it("re-computes on container resize (more space → more pills visible)", async () => {
    render(<AttachmentPillList files={makeFiles(5)} onRemove={vi.fn<(index: number) => void>()} />);

    // Narrow: 3 visible
    await setContainerWidth(400);
    await waitFor(() => expect(visiblePills()).toHaveLength(3));

    // Wider: all 5 fit
    await setContainerWidth(800);
    await waitFor(() => {
      expect(visiblePills()).toHaveLength(5);
      expect(screen.queryByTestId("overflow-pill")).not.toBeInTheDocument();
    });
  });

  it("calls onRemove with the correct original file index", async () => {
    const onRemove = vi.fn<(index: number) => void>();
    render(<AttachmentPillList files={makeFiles(5)} onRemove={onRemove} />);

    await setContainerWidth(400);
    await waitFor(() => expect(visiblePills()).toHaveLength(3));

    // Click remove on the second visible pill (file-2, index 1)
    within(screen.getByTestId("visible-row"))
      .getAllByRole("button", { name: /remove file-2/i })[0]
      .click();

    expect(onRemove).toHaveBeenCalledWith(1);
  });
});
