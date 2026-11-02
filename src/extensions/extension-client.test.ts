import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderHook } from "@/test-utils";

const { contributeMock } = vi.hoisted(() => ({
  contributeMock: vi.fn<(contribution: unknown) => () => void>(),
}));

vi.mock("./registry", () => ({
  registry: {
    contribute: contributeMock,
  },
}));

import type { Extension1PManifest } from "./extension-client";
import { extensionClient, useExtensions } from "./extension-client";
import { SLOT } from "./slot-ids";

const disposers: Array<() => void> = [];

function createManifest(id: string): Extension1PManifest {
  return {
    origin: "marshal-shell",
    id,
    displayName: `Extension ${id}`,
    description: "test extension",
    contributes: {
      slots: [{ slotId: SLOT.CREATE_EDITOR }, { slotId: SLOT.CREATE_CONTENT_HEADER }],
    },
  };
}

function registerManifest(manifest: Extension1PManifest): () => void {
  const rawDispose = extensionClient.register(manifest);
  let disposed = false;
  const trackedDispose = () => {
    if (disposed) return;
    disposed = true;
    rawDispose();
    const idx = disposers.indexOf(trackedDispose);
    if (idx >= 0) disposers.splice(idx, 1);
  };
  disposers.push(trackedDispose);
  return trackedDispose;
}

describe("extensionClient", () => {
  beforeEach(() => {
    contributeMock.mockReset();
    contributeMock.mockImplementation(() => vi.fn<() => void>());
  });

  afterEach(() => {
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      dispose?.();
    }
    vi.restoreAllMocks();
  });

  it("registers manifests as disabled by default", () => {
    const manifest = createManifest("test.ext.disabled");
    registerManifest(manifest);

    expect(extensionClient.list()).toEqual([{ manifest, enabled: false }]);
    expect(contributeMock).not.toHaveBeenCalled();
  });

  it("enables a manifest and contributes every declared slot", () => {
    const manifest = createManifest("test.ext.enable");
    registerManifest(manifest);

    extensionClient.enable(manifest.id);

    expect(contributeMock).toHaveBeenCalledTimes(2);
    expect(contributeMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: `${manifest.id}::${SLOT.CREATE_EDITOR}`,
        extensionId: manifest.id,
        slotId: SLOT.CREATE_EDITOR,
      }),
    );
    expect(contributeMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: `${manifest.id}::${SLOT.CREATE_CONTENT_HEADER}`,
        extensionId: manifest.id,
        slotId: SLOT.CREATE_CONTENT_HEADER,
      }),
    );
    expect(extensionClient.list()).toEqual([{ manifest, enabled: true }]);
  });

  it("disables an enabled manifest and runs all contribution disposers", () => {
    const firstDisposer = vi.fn<() => void>();
    const secondDisposer = vi.fn<() => void>();
    contributeMock
      .mockReset()
      .mockReturnValueOnce(firstDisposer)
      .mockReturnValueOnce(secondDisposer);

    const manifest = createManifest("test.ext.disable");
    registerManifest(manifest);
    extensionClient.enable(manifest.id);

    extensionClient.disable(manifest.id);

    expect(firstDisposer).toHaveBeenCalledTimes(1);
    expect(secondDisposer).toHaveBeenCalledTimes(1);
    expect(extensionClient.list()).toEqual([{ manifest, enabled: false }]);
  });

  it("toggles disable->enable cycle to verify state transitions work", () => {
    const firstDisposer = vi.fn<() => void>();
    const secondDisposer = vi.fn<() => void>();
    const thirdDisposer = vi.fn<() => void>();
    const fourthDisposer = vi.fn<() => void>();

    const manifest = createManifest("test.ext.toggle");
    registerManifest(manifest);

    // Initially disabled
    expect(extensionClient.list()).toEqual([{ manifest, enabled: false }]);
    expect(contributeMock).not.toHaveBeenCalled();

    // Enable: should contribute slots
    contributeMock
      .mockReset()
      .mockReturnValueOnce(firstDisposer)
      .mockReturnValueOnce(secondDisposer);
    extensionClient.enable(manifest.id);
    expect(extensionClient.list()).toEqual([{ manifest, enabled: true }]);
    expect(contributeMock).toHaveBeenCalledTimes(2);

    // Disable: should dispose contributions
    extensionClient.disable(manifest.id);
    expect(firstDisposer).toHaveBeenCalledTimes(1);
    expect(secondDisposer).toHaveBeenCalledTimes(1);
    expect(extensionClient.list()).toEqual([{ manifest, enabled: false }]);

    // Enable again: should re-contribute slots
    contributeMock
      .mockReset()
      .mockReturnValueOnce(thirdDisposer)
      .mockReturnValueOnce(fourthDisposer);
    extensionClient.enable(manifest.id);
    expect(extensionClient.list()).toEqual([{ manifest, enabled: true }]);
    expect(contributeMock).toHaveBeenCalledTimes(2);

    // Disable again: should dispose the new contributions
    extensionClient.disable(manifest.id);
    expect(thirdDisposer).toHaveBeenCalledTimes(1);
    expect(fourthDisposer).toHaveBeenCalledTimes(1);
    expect(extensionClient.list()).toEqual([{ manifest, enabled: false }]);
  });

  it("evicts cached API when manifest is deregistered", () => {
    const extensionId = "test.ext.api.evict";
    const apiBefore = extensionClient.buildApi(extensionId);

    const dispose = registerManifest(createManifest(extensionId));
    dispose();

    const apiAfter = extensionClient.buildApi(extensionId);
    expect(apiAfter).not.toBe(apiBefore);
  });

  it("useExtensions reflects register, enable, and deregister changes", () => {
    const id = "test.ext.hook";
    const manifest = createManifest(id);
    const { result } = renderHook(() => useExtensions());

    expect(result.current).toEqual([]);

    let dispose: () => void = () => {};
    act(() => {
      dispose = registerManifest(manifest);
    });
    expect(result.current).toEqual([{ manifest, enabled: false }]);

    act(() => {
      extensionClient.enable(id);
    });
    expect(result.current).toEqual([{ manifest, enabled: true }]);

    act(() => {
      dispose();
    });
    expect(result.current).toEqual([]);
  });
});
