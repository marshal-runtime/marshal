// marshal-owned renderer test
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { render, within } from "@/test-utils";

import { ZoomControls } from "./ZoomControls";

function renderControls(zoom: number) {
  const onZoomIn = vi.fn<() => void>();
  const onZoomOut = vi.fn<() => void>();
  const onReset = vi.fn<() => void>();
  render(
    <ZoomControls
      zoom={zoom}
      onZoomIn={onZoomIn}
      onZoomOut={onZoomOut}
      onReset={onReset}
      minZoom={0.5}
      maxZoom={2}
    />,
  );
  return { onZoomIn, onZoomOut, onReset };
}

describe("ZoomControls", () => {
  it("renders the current zoom percent", () => {
    renderControls(1.25);
    expect(screen.getByRole("button", { name: /Current zoom 125%/ })).toBeInTheDocument();
  });

  it("rounds to nearest whole percent", () => {
    renderControls(0.67);
    expect(screen.getByRole("button", { name: /Current zoom 67%/ })).toBeInTheDocument();
  });

  it("invokes the right callback for each control", async () => {
    const user = userEvent.setup();
    const { onZoomIn, onZoomOut, onReset } = renderControls(1.25);
    await user.click(screen.getByLabelText("Zoom in"));
    await user.click(screen.getByLabelText("Zoom out"));
    await user.click(screen.getByRole("button", { name: /Current zoom/ }));
    expect(onZoomIn).toHaveBeenCalledTimes(1);
    expect(onZoomOut).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("disables zoom-out at min and zoom-in at max", () => {
    renderControls(0.5);
    expect(screen.getByLabelText("Zoom out")).toBeDisabled();
    expect(screen.getByLabelText("Zoom in")).not.toBeDisabled();
  });

  it("disables zoom-in at max and zoom-out is enabled", () => {
    renderControls(2);
    expect(screen.getByLabelText("Zoom in")).toBeDisabled();
    expect(screen.getByLabelText("Zoom out")).not.toBeDisabled();
  });

  it("disables the reset button at default (100%)", () => {
    renderControls(1);
    expect(screen.getByRole("button", { name: /Current zoom 100%/ })).toBeDisabled();
  });

  it("enables the reset button when zoom is not 1", () => {
    renderControls(1.5);
    expect(screen.getByRole("button", { name: /Current zoom 150%/ })).not.toBeDisabled();
  });

  it("renders tooltip shortcuts with keyboard markup", async () => {
    const user = userEvent.setup();
    renderControls(1.25);

    await user.hover(screen.getByLabelText("Zoom in"));

    const shortcut = (await screen.findAllByLabelText("Ctrl+="))[0];
    expect(shortcut).toHaveAttribute("data-slot", "kbd-group");
    expect(within(shortcut).getByText("Ctrl")).toHaveAttribute("data-slot", "kbd");
    expect(within(shortcut).getByText("=")).toHaveAttribute("data-slot", "kbd");
  });
});
