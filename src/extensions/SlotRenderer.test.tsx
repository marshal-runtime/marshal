import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen } from "@/test-utils";

import { extensionClient } from "./extension-client";
import type { SlotProps } from "./registry";
import { registry } from "./registry";
import { SLOT } from "./slot-ids";
import { SlotRenderer } from "./MarshalSlotRenderer";

const disposers: Array<() => void> = [];

function track(dispose: () => void): () => void {
  let disposed = false;
  const wrapped = () => {
    if (disposed) return;
    disposed = true;
    dispose();
    const idx = disposers.indexOf(wrapped);
    if (idx >= 0) disposers.splice(idx, 1);
  };
  disposers.push(wrapped);
  return wrapped;
}

const baseCtx = {
  activeFile: "notes.md",
  activeFileType: "markdown",
  workspace: "Scratchpad",
  sessionId: "session-1",
} as const;

describe("SlotRenderer", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  afterEach(() => {
    act(() => {
      while (disposers.length > 0) {
        const dispose = disposers.pop();
        dispose?.();
      }
    });
    vi.restoreAllMocks();
  });

  it("renders fallback when no contribution is active", () => {
    render(
      <SlotRenderer
        slotId={SLOT.CREATE_EDITOR}
        slotCtx={baseCtx}
        fallback={<div data-testid="fallback">fallback</div>}
      />,
    );

    expect(screen.getByTestId("fallback")).toBeInTheDocument();
    expect(screen.queryByTestId("contribution")).not.toBeInTheDocument();
  });

  it("renders resolved contribution and passes scoped api + ctx", () => {
    const EditorContribution = (props: SlotProps<typeof SLOT.CREATE_EDITOR>) => {
      return (
        <div data-testid="contribution">
          {props.ctx.activeFile}|{props.api.extensionId}
        </div>
      );
    };

    track(
      registry.contribute({
        id: "ext.slot-renderer::editor",
        extensionId: "ext.slot-renderer",
        slotId: SLOT.CREATE_EDITOR,
        component: EditorContribution,
      }),
    );

    const buildApiSpy = vi.spyOn(extensionClient, "buildApi");

    render(
      <SlotRenderer
        slotId={SLOT.CREATE_EDITOR}
        slotCtx={baseCtx}
        fallback={<div data-testid="fallback">fallback</div>}
      />,
    );

    expect(screen.getByTestId("contribution")).toBeInTheDocument();
    expect(screen.queryByTestId("fallback")).not.toBeInTheDocument();
    expect(buildApiSpy).toHaveBeenCalledWith("ext.slot-renderer");
    expect(screen.getByTestId("contribution")).toHaveTextContent("notes.md|ext.slot-renderer");

    // Verify the API object passed to the component is functional
    const api = buildApiSpy.mock.results[0].value;
    expect(api).toBeDefined();
    expect(api.extensionId).toBe("ext.slot-renderer");
    expect(typeof api.chat?.send).toBe("function");
    expect(typeof api.workspace?.readFile).toBe("function");
    expect(typeof api.workspace?.writeFile).toBe("function");
    expect(typeof api.workspace?.listDir).toBe("function");
    expect(typeof api.skills?.list).toBe("function");
  });

  it("reacts to new contribution after initial render", () => {
    const EditorContribution = (_props: SlotProps<typeof SLOT.CREATE_EDITOR>) => (
      <div data-testid="contribution">contribution</div>
    );

    render(
      <SlotRenderer
        slotId={SLOT.CREATE_EDITOR}
        slotCtx={baseCtx}
        fallback={<div data-testid="fallback">fallback</div>}
      />,
    );

    expect(screen.getByTestId("fallback")).toBeInTheDocument();

    act(() => {
      track(
        registry.contribute({
          id: "ext.slot-renderer::dynamic",
          extensionId: "ext.slot-renderer.dynamic",
          slotId: SLOT.CREATE_EDITOR,
          component: EditorContribution,
        }),
      );
    });

    expect(screen.getByTestId("contribution")).toBeInTheDocument();
    expect(screen.queryByTestId("fallback")).not.toBeInTheDocument();
  });

  it("renders fallback when contribution activateWhen returns false", () => {
    const EditorContribution = (_props: SlotProps<typeof SLOT.CREATE_EDITOR>) => (
      <div data-testid="contribution">contribution</div>
    );
    const activateWhen = vi.fn<() => boolean>(() => false);

    track(
      registry.contribute({
        id: "ext.slot-renderer::inactive",
        extensionId: "ext.slot-renderer.inactive",
        slotId: SLOT.CREATE_EDITOR,
        component: EditorContribution,
        activateWhen,
      }),
    );

    render(
      <SlotRenderer
        slotId={SLOT.CREATE_EDITOR}
        slotCtx={baseCtx}
        fallback={<div data-testid="fallback">fallback</div>}
      />,
    );

    expect(screen.getByTestId("fallback")).toBeInTheDocument();
    expect(screen.queryByTestId("contribution")).not.toBeInTheDocument();
    expect(activateWhen).toHaveBeenCalledWith(baseCtx);
  });

  it("returns to fallback when active contribution is removed", () => {
    const EditorContribution = (_props: SlotProps<typeof SLOT.CREATE_EDITOR>) => (
      <div data-testid="contribution">contribution</div>
    );

    let dispose: () => void = () => {};
    act(() => {
      dispose = track(
        registry.contribute({
          id: "ext.slot-renderer::remove",
          extensionId: "ext.slot-renderer.remove",
          slotId: SLOT.CREATE_EDITOR,
          component: EditorContribution,
        }),
      );
    });

    render(
      <SlotRenderer
        slotId={SLOT.CREATE_EDITOR}
        slotCtx={baseCtx}
        fallback={<div data-testid="fallback">fallback</div>}
      />,
    );

    expect(screen.getByTestId("contribution")).toBeInTheDocument();

    act(() => {
      dispose();
    });

    expect(screen.getByTestId("fallback")).toBeInTheDocument();
    expect(screen.queryByTestId("contribution")).not.toBeInTheDocument();
  });

  describe("subscribeToRegistry={false}", () => {
    it("still resolves and renders an existing contribution", () => {
      const EditorContribution = (_props: SlotProps<typeof SLOT.CREATE_EDITOR>) => (
        <div data-testid="contribution">no-sub</div>
      );

      track(
        registry.contribute({
          id: "ext.slot-renderer::no-sub",
          extensionId: "ext.slot-renderer.no-sub",
          slotId: SLOT.CREATE_EDITOR,
          component: EditorContribution,
        }),
      );

      render(
        <SlotRenderer
          slotId={SLOT.CREATE_EDITOR}
          slotCtx={baseCtx}
          fallback={<div data-testid="fallback">fallback</div>}
          subscribeToRegistry={false}
        />,
      );

      expect(screen.getByTestId("contribution")).toBeInTheDocument();
      expect(screen.queryByTestId("fallback")).not.toBeInTheDocument();
    });

    it("does not call registry.subscribe", () => {
      const subscribeSpy = vi.spyOn(registry, "subscribe");

      render(
        <SlotRenderer
          slotId={SLOT.CREATE_EDITOR}
          slotCtx={baseCtx}
          fallback={<div data-testid="fallback">fallback</div>}
          subscribeToRegistry={false}
        />,
      );

      expect(subscribeSpy).not.toHaveBeenCalled();
    });

    it("does not re-render when a new contribution is added", () => {
      const EditorContribution = (_props: SlotProps<typeof SLOT.CREATE_EDITOR>) => (
        <div data-testid="contribution">contribution</div>
      );

      // Render with no active contribution and subscribeToRegistry=false
      render(
        <SlotRenderer
          slotId={SLOT.CREATE_EDITOR}
          slotCtx={baseCtx}
          fallback={<div data-testid="fallback">fallback</div>}
          subscribeToRegistry={false}
        />,
      );

      expect(screen.getByTestId("fallback")).toBeInTheDocument();

      // Add a contribution — without a subscription, the component should not
      // pick it up automatically.
      act(() => {
        track(
          registry.contribute({
            id: "ext.slot-renderer::no-sub-dynamic",
            extensionId: "ext.slot-renderer.no-sub-dynamic",
            slotId: SLOT.CREATE_EDITOR,
            component: EditorContribution,
          }),
        );
      });

      // Still showing fallback — no subscription means no re-render.
      expect(screen.getByTestId("fallback")).toBeInTheDocument();
      expect(screen.queryByTestId("contribution")).not.toBeInTheDocument();
    });
  });
});
