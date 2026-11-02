// marshal-owned renderer test
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

import { SessionOverflowMenu } from "./SessionOverflowMenu";

// Factory: each call returns a *fresh* spy. Named explicitly so future
// contributors don't read it as a no-op constant and inline `spy()` directly
// (which would discard the spy and silently turn `toHaveBeenCalledOnce()`
// into a tautology against a thrown-away mock).
const spy = () => vi.fn<() => void>();

async function openMenu() {
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: /more actions/i });
  await user.click(trigger);
  return user;
}

describe("SessionOverflowMenu", () => {
  it("always shows Rename and Delete actions", async () => {
    render(<SessionOverflowMenu onRename={spy()} onDelete={spy()} />);
    await openMenu();

    expect(screen.getByRole("menuitem", { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeInTheDocument();
  });

  it("hides 'Open in New Window' when no handler is provided", async () => {
    render(<SessionOverflowMenu onRename={spy()} onDelete={spy()} />);
    await openMenu();

    expect(screen.queryByRole("menuitem", { name: /open in new window/i })).not.toBeInTheDocument();
  });

  it("shows 'Open in New Window' when a handler is provided", async () => {
    render(<SessionOverflowMenu onRename={spy()} onDelete={spy()} onOpenInNewWindow={spy()} />);
    await openMenu();

    expect(screen.getByRole("menuitem", { name: /open in new window/i })).toBeInTheDocument();
  });

  it("invokes onOpenInNewWindow when the Open in New Window item is selected", async () => {
    const onOpenInNewWindow = spy();
    render(
      <SessionOverflowMenu
        onRename={spy()}
        onDelete={spy()}
        onOpenInNewWindow={onOpenInNewWindow}
      />,
    );
    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: /open in new window/i }));

    expect(onOpenInNewWindow).toHaveBeenCalledOnce();
  });

  it("does not bubble its click to the parent row when an item is selected", async () => {
    // Regression: Radix Menu items live in a portal but their
    // click events still propagate through the React parent tree, which would
    // trigger the chat row's onClick (switching the active session in the
    // main window). The fix is a single `onClick` interceptor on the
    // portaled `DropdownMenuContent` that stops propagation for *any* item
    // click — opening a chat in a new window must not move the main window's
    // active-session pointer.
    //
    // NOTE: keyboard activation goes through `onKeyDown` (Enter / Space),
    // which is currently shielded by the parent row's `e.target ===
    // e.currentTarget` guard, not by this `onClick` interceptor. If that
    // guard is removed, add a matching `onKeyDown` interceptor here.
    const onParentClick = spy();
    const onOpenInNewWindow = spy();
    render(
      <div role="button" tabIndex={0} onClick={onParentClick} aria-label="row">
        <SessionOverflowMenu
          onRename={spy()}
          onDelete={spy()}
          onOpenInNewWindow={onOpenInNewWindow}
        />
      </div>,
    );
    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: /open in new window/i }));

    expect(onOpenInNewWindow).toHaveBeenCalledOnce();
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("does not bubble its click to the parent row when Rename is selected", async () => {
    const onParentClick = spy();
    const onRename = spy();
    render(
      <div role="button" tabIndex={0} onClick={onParentClick} aria-label="row">
        <SessionOverflowMenu onRename={onRename} onDelete={spy()} />
      </div>,
    );
    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: /rename/i }));

    expect(onRename).toHaveBeenCalledOnce();
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("does not bubble its click to the parent row when Delete is selected", async () => {
    const onParentClick = spy();
    const onDelete = spy();
    render(
      <div role="button" tabIndex={0} onClick={onParentClick} aria-label="row">
        <SessionOverflowMenu onRename={spy()} onDelete={onDelete} />
      </div>,
    );
    const user = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));

    expect(onDelete).toHaveBeenCalledOnce();
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
