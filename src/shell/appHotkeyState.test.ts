import { describe, expect, it } from "vitest";

import { getAppHotkeyState } from "./appHotkeyState";

describe("getAppHotkeyState", () => {
  it("enables app shortcuts in the main chat view", () => {
    expect(getAppHotkeyState({ currentView: "chat" })).toEqual({
      chatNavigationEnabled: true,
      sidebarToggleEnabled: true,
    });
  });

  it("disables sidebar toggle in create view", () => {
    expect(getAppHotkeyState({ currentView: "create" })).toEqual({
      chatNavigationEnabled: true,
      sidebarToggleEnabled: false,
    });
  });
});
