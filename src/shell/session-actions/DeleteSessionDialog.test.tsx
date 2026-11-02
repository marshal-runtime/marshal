import { describe, expect, it, vi } from "vitest";

import { render, screen, userEvent } from "@/test-utils";

import { DeleteSessionDialog } from "./DeleteSessionDialog";

function renderDialog() {
  const onConfirm = vi.fn<() => void>();
  const onOpenChange = vi.fn<(open: boolean) => void>();
  render(
    <DeleteSessionDialog
      open
      onOpenChange={onOpenChange}
      sessionName="Important session"
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onOpenChange };
}

describe("DeleteSessionDialog", () => {
  it("shows the session name and confirms deletion", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    expect(screen.getByText(/Important session/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancels without confirming", async () => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the confirm callback behavior pending-safe", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn<() => void>(() => undefined);
    render(
      <DeleteSessionDialog
        open
        onOpenChange={vi.fn<(open: boolean) => void>()}
        sessionName="Pending session"
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
