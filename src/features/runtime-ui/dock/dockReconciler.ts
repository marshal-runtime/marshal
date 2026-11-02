import type { RuntimeUiInstance } from "@common/runtime-ui";
import {
  dockRegionForSurface,
  runtimeUiInstanceTitle,
  type RuntimeUiDockRegion,
} from "@common/runtime-ui-layout";
import type { DockviewApi } from "dockview-react";

import {
  addPanelInRegion,
  DOCK_COMPONENT,
  instanceIdOfPanel,
  movePanelToRegion,
  syncEdgeVisibility,
  viewPanelId,
} from "./dockLayout";

interface SeenView {
  readonly surface: RuntimeUiInstance["surface"];
  readonly focusedAt: string;
  readonly title: string;
}

/**
 * Mirrors the session's docked views into dockview tabs. Only changes the
 * agent (or another client) made are applied: a surface that changed since
 * the last pass moves the tab, a newer desktop focus activates it. A tab the
 * user dragged stays where they put it until the host records the move.
 */
export class DockReconciler {
  private readonly seen = new Map<string, SeenView>();
  /** Panels this reconciler removed, so removal is not mistaken for a user close. */
  readonly removing = new Set<string>();
  /** Maximizes a view's tab when it enters fullscreen. */
  onFullscreen: ((panelId: string) => void) | undefined;
  /** Called before a view's tab moves because its surface changed. */
  onSurfaceChange: ((panelId: string) => void) | undefined;

  reset(): void {
    this.seen.clear();
  }

  /** True once the tab reflects this surface, so a region mismatch means the user moved it. */
  isSettled(instance: RuntimeUiInstance): boolean {
    return this.seen.get(instance.instanceId)?.surface === instance.surface;
  }

  /** Returns true when the arrangement changed, so the caller saves it. */
  apply(api: DockviewApi, docked: readonly RuntimeUiInstance[]): boolean {
    let changed = false;
    const wanted = new Map(docked.map((instance) => [viewPanelId(instance.instanceId), instance]));
    for (const panel of [...api.panels]) {
      const instanceId = instanceIdOfPanel(panel.id);
      if (!instanceId || wanted.has(panel.id)) continue;
      this.removing.add(panel.id);
      api.removePanel(panel);
      this.seen.delete(instanceId);
      changed = true;
    }
    // Oldest first, so tabs keep the order views were opened in.
    const ordered = [...docked].sort((left, right) => left.openedAt.localeCompare(right.openedAt));
    for (const instance of ordered) changed = this.applyOne(api, instance) || changed;
    syncEdgeVisibility(api, false);
    return changed;
  }

  private applyOne(api: DockviewApi, instance: RuntimeUiInstance): boolean {
    const region = dockRegionForSurface(instance.surface);
    if (!region) return false;
    const before = this.seen.get(instance.instanceId);
    this.place(api, instance, region);
    const after = this.seen.get(instance.instanceId);
    return (
      before?.surface !== after?.surface ||
      before?.focusedAt !== after?.focusedAt ||
      before?.title !== after?.title
    );
  }

  private place(api: DockviewApi, instance: RuntimeUiInstance, region: RuntimeUiDockRegion): void {
    const id = viewPanelId(instance.instanceId);
    const title = runtimeUiInstanceTitle(instance);
    const previous = this.seen.get(instance.instanceId);
    const remote = instance.focusedBy === "remote";
    let panel = api.getPanel(id);
    if (!panel) {
      panel = addPanelInRegion(
        api,
        { id, component: DOCK_COMPONENT.view, title, params: { instanceId: instance.instanceId } },
        region,
        // Remote-originated opens never steal the desktop's active tab.
        remote,
      );
    } else {
      if (panel.title !== title) panel.api.setTitle(title);
      if (previous && previous.surface !== instance.surface) {
        this.onSurfaceChange?.(id);
        movePanelToRegion(api, panel, region);
      }
      if (previous && previous.focusedAt !== instance.focusedAt && !remote) panel.api.setActive();
    }
    if (instance.surface === "fullscreen" && previous?.surface !== "fullscreen") {
      this.onFullscreen?.(id);
    }
    this.seen.set(instance.instanceId, {
      surface: instance.surface,
      focusedAt: instance.focusedAt,
      title,
    });
  }
}
