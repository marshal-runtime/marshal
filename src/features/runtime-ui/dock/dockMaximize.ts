import type { RuntimeUiDockRegion } from "@common/runtime-ui-layout";
import type { DockviewApi } from "dockview-react";

import { DOCK_MAXIMIZED_CLASS, movePanelToRegion, regionOfPanel } from "./dockLayout";

/** A tab shown over the whole dock area, and the region it returns to. */
export interface MaximizedView {
  readonly panelId: string;
  readonly home: RuntimeUiDockRegion;
}

/**
 * Maximizes a tab by moving it into a floating window that fills the dock
 * area. Dockview's own maximize only works inside the center grid (the side
 * and bottom docks ignore it), while floating windows already sit above every
 * dock and divider with their content rendered in place.
 */
export function maximizePanel(
  api: DockviewApi,
  panelId: string,
  dockRoot: HTMLElement,
  home?: RuntimeUiDockRegion,
): MaximizedView | undefined {
  const panel = api.getPanel(panelId);
  if (!panel) return undefined;
  const origin = home ?? regionOfPanel(panel);
  const rect = dockRoot.getBoundingClientRect();
  api.addFloatingGroup(panel, { x: 0, y: 0, width: rect.width, height: rect.height });
  panel.group.element.closest(".dv-resize-container")?.classList.add(DOCK_MAXIMIZED_CLASS);
  panel.api.setActive();
  return { panelId, home: origin };
}

/** Puts a maximized tab back in the region it came from. */
export function restorePanel(api: DockviewApi, view: MaximizedView): void {
  const panel = api.getPanel(view.panelId);
  if (!panel) return;
  movePanelToRegion(api, panel, view.home);
  panel.api.setActive();
}
