import { describe, expect, it, vi } from "vitest";

const applyWindowTitleMock = vi.hoisted(() => vi.fn<(mode: string, win: unknown) => void>());

vi.mock("./app-badge", () => ({
  applyWindowTitle: applyWindowTitleMock,
}));

import type { BrowserWindow } from "electron";

import type { AppMode } from "../common/marshal-constants";
import { installNativeTitleSync } from "./main-window-branding";
import { testDouble } from "./testing/harness";

function makeWin() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const on = vi.fn<(event: string, handler: (...args: unknown[]) => void) => BrowserWindow>();
  const win: BrowserWindow = testDouble<BrowserWindow>({ on });
  on.mockImplementation((event, handler) => {
    handlers.set(event, handler);
    return win;
  });
  return {
    win,
    fire: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
  };
}

describe("installNativeTitleSync", () => {
  it("prevents renderer title updates from overwriting native main-window branding", () => {
    applyWindowTitleMock.mockClear();
    const { win, fire } = makeWin();
    const getEffectiveAppMode = vi.fn<() => AppMode>().mockReturnValue("beta");

    installNativeTitleSync(win, getEffectiveAppMode);
    const event = { preventDefault: vi.fn<() => void>() };
    fire("page-title-updated", event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(getEffectiveAppMode).toHaveBeenCalledOnce();
    expect(applyWindowTitleMock).toHaveBeenCalledWith("beta", win);
  });

  it("reads the current effective mode on every event so post-startup mode flips apply", () => {
    applyWindowTitleMock.mockClear();
    const { win, fire } = makeWin();
    let mode: AppMode = "release";
    installNativeTitleSync(win, () => mode);

    fire("page-title-updated", { preventDefault: vi.fn<() => void>() });
    mode = "beta";
    fire("page-title-updated", { preventDefault: vi.fn<() => void>() });

    expect(applyWindowTitleMock).toHaveBeenNthCalledWith(1, "release", win);
    expect(applyWindowTitleMock).toHaveBeenNthCalledWith(2, "beta", win);
  });
});
