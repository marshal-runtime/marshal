import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { render, screen } from "@/test-utils";

import { SurfaceHeader } from "./surface-header";

describe("SurfaceHeader", () => {
  it("renders the surface title", () => {
    render(<SurfaceHeader title="Activity" />);
    expect(screen.getByRole("heading", { name: "Activity" })).toBeInTheDocument();
  });

  it("renders and invokes Close when onClose is provided", async () => {
    const onClose = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<SurfaceHeader title="Activity" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("omits Close when onClose is not provided", () => {
    render(<SurfaceHeader title="Activity" />);
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("renders and invokes Back when onBack is provided", async () => {
    const onBack = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<SurfaceHeader title="Memories" onBack={onBack} />);

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("omits Back when onBack is not provided", () => {
    render(<SurfaceHeader title="Memories" />);
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });
});
