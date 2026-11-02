// marshal-owned renderer test
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderHook } from "@/test-utils";

import { registry, useRegistryVersion } from "./registry";
import type { SlotProps } from "./registry";
import { SLOT } from "./slot-ids";

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

const EditorComponent = (_props: SlotProps<typeof SLOT.CREATE_EDITOR>) => null;
const EditorComponentAlt = (_props: SlotProps<typeof SLOT.CREATE_EDITOR>) => null;
const HeaderComponent = (_props: SlotProps<typeof SLOT.CREATE_CONTENT_HEADER>) => null;

afterEach(() => {
  while (disposers.length > 0) {
    const dispose = disposers.pop();
    dispose?.();
  }
  vi.restoreAllMocks();
});

describe("registry", () => {
  it("resolves a matching slot contribution", () => {
    const component = EditorComponent;
    track(
      registry.contribute({
        id: "ext-1::editor",
        extensionId: "ext-1",
        slotId: SLOT.CREATE_EDITOR,
        component,
      }),
    );

    const resolved = registry.resolve(SLOT.CREATE_EDITOR, {
      activeFile: "notes.md",
      activeFileType: "markdown",
      workspace: "Scratchpad",
      sessionId: "session-1",
    });

    expect(resolved).toEqual({
      component,
      extensionId: "ext-1",
    });
  });

  it("prefers the first registered active contribution for a slot", () => {
    track(
      registry.contribute({
        id: "ext-first::editor",
        extensionId: "ext-first",
        slotId: SLOT.CREATE_EDITOR,
        component: EditorComponent,
      }),
    );
    track(
      registry.contribute({
        id: "ext-second::editor",
        extensionId: "ext-second",
        slotId: SLOT.CREATE_EDITOR,
        component: EditorComponentAlt,
      }),
    );

    const resolved = registry.resolve(SLOT.CREATE_EDITOR, {
      activeFile: "notes.md",
      activeFileType: "markdown",
      workspace: "Scratchpad",
      sessionId: "session-1",
    });

    expect(resolved).toEqual({
      component: EditorComponent,
      extensionId: "ext-first",
    });
  });

  it("re-registering the same id replaces the previous contribution", () => {
    const id = "ext-same::editor";
    track(
      registry.contribute({
        id,
        extensionId: "ext-original",
        slotId: SLOT.CREATE_EDITOR,
        component: EditorComponent,
      }),
    );
    track(
      registry.contribute({
        id,
        extensionId: "ext-replacement",
        slotId: SLOT.CREATE_EDITOR,
        component: EditorComponentAlt,
      }),
    );

    const resolved = registry.resolve(SLOT.CREATE_EDITOR, {
      activeFile: "notes.md",
      activeFileType: "markdown",
      workspace: "Scratchpad",
      sessionId: "session-1",
    });

    expect(resolved).toEqual({
      component: EditorComponentAlt,
      extensionId: "ext-replacement",
    });
  });

  it("returns null when contribution has no component", () => {
    track(
      registry.contribute({
        id: "ext-2::editor",
        extensionId: "ext-2",
        slotId: SLOT.CREATE_EDITOR,
      }),
    );

    const resolved = registry.resolve(SLOT.CREATE_EDITOR, {
      activeFile: null,
      activeFileType: null,
      workspace: "Scratchpad",
      sessionId: null,
    });

    expect(resolved).toBeNull();
  });

  it("honors activateWhen and only resolves active contributions", () => {
    const component = EditorComponent;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activateSpy = vi.fn<(ctx: unknown) => boolean>((ctx: any) => {
      return ctx.activeFileType === "com.example.people.person";
    });
    track(
      registry.contribute({
        id: "ext-3::editor",
        extensionId: "ext-3",
        slotId: SLOT.CREATE_EDITOR,
        component,
        activateWhen: activateSpy,
      }),
    );

    const inactiveCtx = {
      activeFile: "notes.md",
      activeFileType: "markdown",
      workspace: "Scratchpad",
      sessionId: "session-1",
    };
    const inactive = registry.resolve(SLOT.CREATE_EDITOR, inactiveCtx);
    expect(inactive).toBeNull();
    // Verify activateWhen was actually invoked with the correct context
    expect(activateSpy).toHaveBeenCalledWith(inactiveCtx);
    expect(activateSpy).toHaveReturnedWith(false);

    activateSpy.mockClear();

    const activeCtx = {
      activeFile: "person.md",
      activeFileType: "com.example.people.person",
      workspace: "Scratchpad",
      sessionId: "session-1",
    };
    const active = registry.resolve(SLOT.CREATE_EDITOR, activeCtx);
    expect(active).toEqual({ component, extensionId: "ext-3" });
    // Verify activateWhen was called with the correct active context
    expect(activateSpy).toHaveBeenCalledWith(activeCtx);
    expect(activateSpy).toHaveReturnedWith(true);
  });

  it("treats a throwing activateWhen as inactive", () => {
    const component = EditorComponent;
    const ctx = {
      activeFile: "notes.md",
      activeFileType: "markdown",
      workspace: "Scratchpad",
      sessionId: "session-1",
    };
    track(
      registry.contribute({
        id: "ext-throw::editor",
        extensionId: "ext-throw",
        slotId: SLOT.CREATE_EDITOR,
        component,
        activateWhen: () => {
          throw new Error("guard exploded");
        },
      }),
    );

    // Should not throw; activateWhen error is caught and logged
    expect(() => registry.resolve(SLOT.CREATE_EDITOR, ctx)).not.toThrow();
    // Contribution is treated as inactive (returns null)
    expect(registry.resolve(SLOT.CREATE_EDITOR, ctx)).toBeNull();
  });

  it("dispose deregisters contribution and increments version", () => {
    const versionBefore = registry.getVersion();
    const component = EditorComponent;
    const dispose = track(
      registry.contribute({
        id: "ext-4::editor",
        extensionId: "ext-4",
        slotId: SLOT.CREATE_EDITOR,
        component,
      }),
    );

    expect(registry.getVersion()).toBe(versionBefore + 1);
    expect(
      registry.resolve(SLOT.CREATE_EDITOR, {
        activeFile: "notes.md",
        activeFileType: "markdown",
        workspace: "Scratchpad",
        sessionId: "session-1",
      }),
    ).toEqual({ component, extensionId: "ext-4" });

    dispose();

    expect(registry.getVersion()).toBe(versionBefore + 2);
    expect(
      registry.resolve(SLOT.CREATE_EDITOR, {
        activeFile: "notes.md",
        activeFileType: "markdown",
        workspace: "Scratchpad",
        sessionId: "session-1",
      }),
    ).toBeNull();
  });

  it("useRegistryVersion updates on contribute and dispose", () => {
    const { result } = renderHook(() => useRegistryVersion());
    const start = result.current;

    let dispose: () => void = () => {};
    act(() => {
      dispose = track(
        registry.contribute({
          id: "ext-5::header",
          extensionId: "ext-5",
          slotId: SLOT.CREATE_CONTENT_HEADER,
          component: HeaderComponent,
        }),
      );
    });
    expect(result.current).toBe(start + 1);

    act(() => {
      dispose();
    });
    expect(result.current).toBe(start + 2);
  });
});
