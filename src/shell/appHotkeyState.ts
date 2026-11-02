import type { AnyNavView } from "./useNavigation";

interface AppHotkeyStateOptions {
  currentView: AnyNavView;
}

export function getAppHotkeyState({ currentView }: AppHotkeyStateOptions) {
  return {
    chatNavigationEnabled: true,
    sidebarToggleEnabled: currentView !== "create",
  };
}
