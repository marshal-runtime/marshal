import { DEFAULT_SHOW_HIDE_SHORTCUT } from "@common/marshal/show-hide-shortcut";
import { describe, expect, it } from "vitest";

import {
  electronAcceleratorToTanStackHotkey,
  tanStackHotkeyToElectronAccelerator,
  validateShowHideHotkey,
} from "./accelerator-codec";

describe("show/hide accelerator conversion", () => {
  it("keeps the current default round-trippable", () => {
    expect(DEFAULT_SHOW_HIDE_SHORTCUT).toBe("Control+Alt+Space");
    expect(electronAcceleratorToTanStackHotkey("Control+Alt+Space")).toEqual({
      success: true,
      hotkey: "Control+Alt+Space",
    });
    expect(tanStackHotkeyToElectronAccelerator("Control+Alt+Space")).toEqual({
      success: true,
      accelerator: "Control+Alt+Space",
    });
  });

  it("converts portable Mod to Electron CommandOrControl", () => {
    expect(tanStackHotkeyToElectronAccelerator("Mod+Shift+K")).toEqual({
      success: true,
      accelerator: "CommandOrControl+Shift+K",
    });
    expect(validateShowHideHotkey("Mod++")).toEqual({
      success: true,
      accelerator: "CommandOrControl++",
    });
  });

  it("normalizes common modifier labels", () => {
    expect(tanStackHotkeyToElectronAccelerator("Ctrl+Option+Space")).toEqual({
      success: true,
      accelerator: "Control+Alt+Space",
    });
  });

  it("rejects whitespace-only accelerator tokens", () => {
    expect(tanStackHotkeyToElectronAccelerator("Control+  +K")).toEqual({
      success: false,
      error: "Hotkey contains a blank token.",
    });
    expect(tanStackHotkeyToElectronAccelerator("Control+  +")).toEqual({
      success: false,
      error: "Hotkey contains a blank token.",
    });
  });

  it("rejects single printable keys for the global show/hide shortcut", () => {
    expect(validateShowHideHotkey("A")).toEqual({
      success: false,
      error: "Use at least one modifier for the global show/hide shortcut.",
    });
    expect(validateShowHideHotkey("+")).toEqual({
      success: false,
      error: "Use at least one modifier for the global show/hide shortcut.",
    });
  });

  it("permits bare non-printable keys for the global show/hide shortcut", () => {
    expect(validateShowHideHotkey("F13")).toEqual({
      success: true,
      accelerator: "F13",
    });
  });

  it("rejects modifier-only recordings", () => {
    expect(validateShowHideHotkey("Control")).toEqual({
      success: false,
      error: "Press a non-modifier key with the shortcut.",
    });
  });

  it("rejects multiple non-modifier keys", () => {
    expect(tanStackHotkeyToElectronAccelerator("Control+A+B")).toEqual({
      success: false,
      error: "Use only one non-modifier key in the shortcut.",
    });
    expect(electronAcceleratorToTanStackHotkey("Control+A+B")).toEqual({
      success: false,
      error: "Use only one non-modifier key in the shortcut.",
    });
  });
});
