import type {
  RuntimeUiDockRegion,
  RuntimeUiDockState,
  RuntimeUiLayoutSummary,
  RuntimeUiViewPlacement,
} from "@common/runtime-ui-layout";
import type {
  AddPanelOptions,
  DockviewApi,
  DockviewGroupPanel,
  IDockviewPanel,
} from "dockview-react";

export const CHAT_PANEL_ID = "marshal.chat";
export const PROGRESS_PANEL_ID = "marshal.progress";
export const SIDE_GROUP_ID = "marshal.side";
export const BOTTOM_GROUP_ID = "marshal.bottom";
const VIEW_PREFIX = "view:";
/** Marks the floating window that shows a maximized tab over the dock area. */
export const DOCK_MAXIMIZED_CLASS = "session-dock-maximized";

export const DOCK_COMPONENT = {
  chat: "chat",
  progress: "progress",
  view: "view",
} as const;

const DEFAULT_SIDE_SIZE = 420;
const DEFAULT_BOTTOM_SIZE = 300;
// Docks may grow until the chat keeps only a sliver; dockview clamps to the window.
const MAX_DOCK_SIZE = 100_000;

export function viewPanelId(instanceId: string): string {
  return `${VIEW_PREFIX}${instanceId}`;
}

export function instanceIdOfPanel(panelId: string): string | undefined {
  return panelId.startsWith(VIEW_PREFIX) ? panelId.slice(VIEW_PREFIX.length) : undefined;
}

export function regionOfGroup(group: DockviewGroupPanel): RuntimeUiDockRegion {
  const location = group.api.location;
  if (location.type === "floating" || location.type === "popout") return "floating";
  if (location.type === "edge") return location.position === "bottom" ? "bottom" : "side";
  return "chat";
}

export function isDockGroupOverlaid(group: DockviewGroupPanel): boolean {
  return group.element.closest(`.${DOCK_MAXIMIZED_CLASS}`) !== null;
}

export function regionOfPanel(panel: IDockviewPanel): RuntimeUiDockRegion {
  return regionOfGroup(panel.group);
}

/** The side and bottom docks always exist; they are hidden while empty. */
export function ensureEdgeGroups(api: DockviewApi): void {
  if (!api.getEdgeGroup("right")) {
    api.addEdgeGroup("right", {
      id: SIDE_GROUP_ID,
      initialSize: DEFAULT_SIDE_SIZE,
      minimumSize: 220,
      maximumSize: MAX_DOCK_SIZE,
    });
  }
  if (!api.getEdgeGroup("bottom")) {
    api.addEdgeGroup("bottom", {
      id: BOTTOM_GROUP_ID,
      initialSize: DEFAULT_BOTTOM_SIZE,
      minimumSize: 120,
      maximumSize: MAX_DOCK_SIZE,
    });
  }
  // Edge groups default to a tab strip along the window edge; docks read as panels with a top strip.
  api.getEdgeGroup("right")?.setHeaderPosition("top");
  api.getEdgeGroup("bottom")?.setHeaderPosition("top");
}

function edgeGroup(api: DockviewApi, region: "side" | "bottom"): DockviewGroupPanel | undefined {
  return api.groups.find(
    (group) =>
      group.api.location.type === "edge" &&
      group.api.location.position === (region === "side" ? "right" : "bottom"),
  );
}

export function chatGroup(api: DockviewApi): DockviewGroupPanel | undefined {
  return (
    api.getPanel(CHAT_PANEL_ID)?.group ??
    api.groups.find((group) => regionOfGroup(group) === "chat")
  );
}

const MIN_CHAT_WIDTH = 320;
const MIN_CHAT_HEIGHT = 240;

/**
 * Keeps the chat column usable: dockview lets an edge dock squeeze the center
 * to 100px and offers no live maximum, so an oversized dock is shrunk back.
 */
export function keepChatUsable(
  api: DockviewApi,
  dock: { readonly width: number; readonly height: number },
): void {
  const side = edgeGroup(api, "side");
  const maxSide = dock.width - MIN_CHAT_WIDTH;
  if (side && side.panels.length > 0 && maxSide > 0 && side.width > maxSide) {
    side.api.setSize({ width: maxSide });
  }
  const bottom = edgeGroup(api, "bottom");
  const maxBottom = dock.height - MIN_CHAT_HEIGHT;
  if (bottom && bottom.panels.length > 0 && maxBottom > 0 && bottom.height > maxBottom) {
    bottom.api.setSize({ height: maxBottom });
  }
}

/** Shows a dock that has tabs (or is a drop target mid-drag) and hides an empty one. */
export function syncEdgeVisibility(api: DockviewApi, dragging: boolean): void {
  for (const [region, position] of [
    ["side", "right"],
    ["bottom", "bottom"],
  ] as const) {
    const group = edgeGroup(api, region);
    if (!group) continue;
    const visible = dragging || group.panels.length > 0;
    if (api.isEdgeGroupVisible(position) !== visible) api.setEdgeGroupVisible(position, visible);
    if (visible) expandEdgeGroup(group);
  }
}

// Dockview collapses an emptied edge group to a bare strip; a shown dock needs its full size.
function expandEdgeGroup(group: DockviewGroupPanel): void {
  if (group.api.isCollapsed()) group.api.expand();
}

type PanelSpec = Pick<AddPanelOptions, "id" | "component" | "title" | "params" | "tabComponent">;

/** Adds a panel as a new tab in a region, never replacing what is there. */
export function addPanelInRegion(
  api: DockviewApi,
  spec: PanelSpec,
  region: RuntimeUiDockRegion,
  inactive: boolean,
): IDockviewPanel {
  const common = { ...spec, renderer: "always" as const, inactive };
  if (region === "floating") {
    const existing = api.groups.find((group) => regionOfGroup(group) === "floating");
    if (existing) return api.addPanel({ ...common, position: { referenceGroup: existing } });
    return api.addPanel({ ...common, floating: floatingBounds() });
  }
  const target = region === "chat" ? chatGroup(api) : edgeGroup(api, region);
  if (target) {
    if (region !== "chat") syncEdgeVisibilityFor(api, region, true);
    return api.addPanel({ ...common, position: { referenceGroup: target } });
  }
  return api.addPanel(common);
}

export function movePanelToRegion(
  api: DockviewApi,
  panel: IDockviewPanel,
  region: RuntimeUiDockRegion,
): void {
  if (regionOfPanel(panel) === region) return;
  if (region === "floating") {
    api.addFloatingGroup(panel, floatingBounds());
    return;
  }
  const target = region === "chat" ? chatGroup(api) : edgeGroup(api, region);
  if (!target) return;
  if (region !== "chat") syncEdgeVisibilityFor(api, region, true);
  panel.api.moveTo({ group: target });
}

function syncEdgeVisibilityFor(api: DockviewApi, region: "side" | "bottom", visible: boolean) {
  const position = region === "side" ? "right" : "bottom";
  if (api.isEdgeGroupVisible(position) !== visible) api.setEdgeGroupVisible(position, visible);
  const group = edgeGroup(api, region);
  if (visible && group) expandEdgeGroup(group);
}

function floatingBounds() {
  const width = Math.min(560, Math.round(window.innerWidth * 0.5));
  const height = Math.min(420, Math.round(window.innerHeight * 0.5));
  return {
    width,
    height,
    x: Math.max(24, Math.round((window.innerWidth - width) / 2)),
    y: Math.max(24, Math.round((window.innerHeight - height) / 3)),
  };
}

function dockState(api: DockviewApi, region: "side" | "bottom"): RuntimeUiDockState {
  const group = edgeGroup(api, region);
  const position = region === "side" ? "right" : "bottom";
  if (!group) return { visible: false };
  return {
    visible: api.isEdgeGroupVisible(position),
    size: Math.round(region === "side" ? group.width : group.height),
  };
}

/** The agent-readable summary of where every view tab currently sits. */
export function summarizeLayout(api: DockviewApi): RuntimeUiLayoutSummary {
  const placements: RuntimeUiViewPlacement[] = [];
  for (const group of api.groups) {
    const region = regionOfGroup(group);
    group.panels.forEach((panel, index) => {
      const instanceId = instanceIdOfPanel(panel.id);
      if (!instanceId) return;
      placements.push({
        instanceId,
        region,
        groupId: group.id,
        index,
        active: group.activePanel?.id === panel.id,
      });
    });
  }
  const maximized = api.groups.find(isDockGroupOverlaid);
  return {
    placements,
    side: dockState(api, "side"),
    bottom: dockState(api, "bottom"),
    floating: api.groups
      .filter((group) => regionOfGroup(group) === "floating")
      .map((group) => {
        const rect = group.element.getBoundingClientRect();
        return {
          groupId: group.id,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      }),
    ...(maximized ? { maximizedGroupId: maximized.id } : {}),
    window: { width: window.innerWidth, height: window.innerHeight },
  };
}
