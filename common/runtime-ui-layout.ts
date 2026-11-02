import type {
  RuntimeUiInstance,
  RuntimeUiJsonValue,
  RuntimeUiScope,
  RuntimeUiSurface,
} from "./runtime-ui";

/**
 * Agent-facing placement names. Each maps onto one host surface; `card` and
 * `transient` both live on the `inline-card` surface and differ only by the
 * instance's `transient` marker.
 */
export type RuntimeUiPlacementName =
  | "chat-tab"
  | "side"
  | "bottom"
  | "floating"
  | "card"
  | "transient"
  | "fullscreen";

export const RUNTIME_UI_PLACEMENT_NAMES: readonly RuntimeUiPlacementName[] = [
  "chat-tab",
  "side",
  "bottom",
  "floating",
  "card",
  "transient",
  "fullscreen",
];

const SURFACE_BY_PLACEMENT: Readonly<Record<RuntimeUiPlacementName, RuntimeUiSurface>> = {
  "chat-tab": "tab",
  side: "panel",
  bottom: "bottom-panel",
  floating: "floating",
  card: "inline-card",
  transient: "inline-card",
  fullscreen: "fullscreen",
};

export function isRuntimeUiPlacementName(value: unknown): value is RuntimeUiPlacementName {
  return RUNTIME_UI_PLACEMENT_NAMES.some((name) => name === value);
}

export function surfaceForPlacement(placement: RuntimeUiPlacementName): RuntimeUiSurface {
  return SURFACE_BY_PLACEMENT[placement];
}

const PLACEMENT_BY_DOCKED_SURFACE: Readonly<
  Record<Exclude<RuntimeUiSurface, "inline-card">, RuntimeUiPlacementName>
> = {
  tab: "chat-tab",
  panel: "side",
  "bottom-panel": "bottom",
  floating: "floating",
  fullscreen: "fullscreen",
};

export function placementForInstance(
  instance: Pick<RuntimeUiInstance, "surface" | "transient">,
): RuntimeUiPlacementName {
  if (instance.surface === "inline-card") return instance.transient ? "transient" : "card";
  return PLACEMENT_BY_DOCKED_SURFACE[instance.surface];
}

/** Docked surfaces render as tabs in the dock layout; cards render in the transcript. */
export function isDockedSurface(surface: RuntimeUiSurface): boolean {
  return surface !== "inline-card";
}

/** The dock region a tab currently sits in, as the desktop layout reports it. */
export type RuntimeUiDockRegion = "chat" | "side" | "bottom" | "floating";

const SURFACE_BY_DOCK_REGION: Readonly<Record<RuntimeUiDockRegion, RuntimeUiSurface>> = {
  chat: "tab",
  side: "panel",
  bottom: "bottom-panel",
  floating: "floating",
};

const DOCK_REGION_BY_SURFACE: Readonly<Record<RuntimeUiSurface, RuntimeUiDockRegion | undefined>> =
  {
    tab: "chat",
    fullscreen: "chat",
    panel: "side",
    "bottom-panel": "bottom",
    floating: "floating",
    "inline-card": undefined,
  };

export function surfaceForDockRegion(region: RuntimeUiDockRegion): RuntimeUiSurface {
  return SURFACE_BY_DOCK_REGION[region];
}

export function dockRegionForSurface(surface: RuntimeUiSurface): RuntimeUiDockRegion | undefined {
  return DOCK_REGION_BY_SURFACE[surface];
}

export interface RuntimeUiLayoutBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where one docked view sits, as reported by the desktop layout. */
export interface RuntimeUiViewPlacement {
  readonly instanceId: string;
  readonly region: RuntimeUiDockRegion;
  readonly groupId: string;
  readonly index: number;
  readonly active: boolean;
}

export interface RuntimeUiDockState {
  readonly visible: boolean;
  /** Pixels along the dock's resize axis (width for side, height for bottom). */
  readonly size?: number;
  readonly collapsed?: boolean;
}

export interface RuntimeUiFloatingGroupState {
  readonly groupId: string;
  readonly bounds: RuntimeUiLayoutBounds;
}

/** The normalized, agent-readable part of a saved desktop layout. */
export interface RuntimeUiLayoutSummary {
  readonly placements: readonly RuntimeUiViewPlacement[];
  readonly side: RuntimeUiDockState;
  readonly bottom: RuntimeUiDockState;
  readonly floating: readonly RuntimeUiFloatingGroupState[];
  readonly maximizedGroupId?: string;
  readonly window?: { readonly width: number; readonly height: number };
}

/**
 * A session's saved desktop layout: dockview's own serialization (opaque to
 * main, replayed by the renderer) plus the normalized summary main reads.
 */
export interface RuntimeUiDesktopLayout {
  readonly version: 1;
  readonly savedAt: string;
  readonly dockview: { readonly [key: string]: RuntimeUiJsonValue };
  readonly summary: RuntimeUiLayoutSummary;
}

/**
 * A tab the user dragged to another region. `fromSurface` is the surface the
 * client saw; the host applies the move only if the view still has it, so a
 * stale save never undoes a newer move made by the agent.
 */
export interface RuntimeUiUserMove {
  readonly instanceId: string;
  readonly fromSurface: RuntimeUiSurface;
  readonly region: RuntimeUiDockRegion;
}

export interface RuntimeUiLayoutSaveRequest extends RuntimeUiScope {
  readonly layout: Omit<RuntimeUiDesktopLayout, "savedAt" | "version">;
  readonly moves?: readonly RuntimeUiUserMove[];
}

export interface RuntimeUiLayoutSnapshot {
  readonly scope: RuntimeUiScope;
  readonly desktop?: RuntimeUiDesktopLayout;
}

/** One attached view as the agent sees it through `ui.layout.get`. */
export interface RuntimeUiLayoutView {
  readonly instanceId: string;
  readonly title: string;
  readonly extensionId: string;
  readonly applicationId: string;
  readonly placement: RuntimeUiPlacementName;
  readonly contentKind: RuntimeUiInstance["content"]["kind"];
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly focusedAt: string;
  readonly dock?: {
    readonly region: RuntimeUiDockRegion;
    readonly groupId: string;
    readonly index: number;
    readonly active: boolean;
  };
  readonly anchor?: RuntimeUiInstance["anchor"];
  readonly expiresAt?: string;
}

export interface RuntimeUiLayoutReport {
  readonly views: readonly RuntimeUiLayoutView[];
  readonly docks: {
    readonly side: RuntimeUiDockState;
    readonly bottom: RuntimeUiDockState;
    readonly floating: readonly RuntimeUiFloatingGroupState[];
    readonly maximizedGroupId?: string;
  };
  /** True when no desktop client has reported an arrangement yet. */
  readonly layoutUnreported: boolean;
}

const HASH_LIKE = /^[0-9a-f]{40,}$/i;

export function runtimeUiInstanceTitle(instance: RuntimeUiInstance): string {
  if (instance.title?.trim()) return instance.title.trim();
  if (instance.content.kind === "file") {
    return instance.content.path.split(/[\\/]/).pop() || instance.content.path;
  }
  if (instance.content.kind === "application") {
    const name = instance.content.resource.name?.trim();
    if (name && !HASH_LIKE.test(name)) return name;
  }
  if (HASH_LIKE.test(instance.owner.applicationId)) return "Agent-authored view";
  return instance.owner.applicationId;
}

export function buildRuntimeUiLayoutReport(
  instances: readonly RuntimeUiInstance[],
  desktop: RuntimeUiDesktopLayout | undefined,
): RuntimeUiLayoutReport {
  const placements = new Map(
    (desktop?.summary.placements ?? []).map((placement) => [placement.instanceId, placement]),
  );
  const views = instances.map((instance): RuntimeUiLayoutView => {
    const docked = placements.get(instance.instanceId);
    return {
      instanceId: instance.instanceId,
      title: runtimeUiInstanceTitle(instance),
      extensionId: instance.owner.extensionId,
      applicationId: instance.owner.applicationId,
      placement: placementForInstance(instance),
      contentKind: instance.content.kind,
      openedAt: instance.openedAt,
      updatedAt: instance.updatedAt,
      focusedAt: instance.focusedAt,
      ...(docked && isDockedSurface(instance.surface)
        ? {
            dock: {
              region: docked.region,
              groupId: docked.groupId,
              index: docked.index,
              active: docked.active,
            },
          }
        : {}),
      ...(instance.anchor ? { anchor: instance.anchor } : {}),
      ...(instance.transient?.expiresAt ? { expiresAt: instance.transient.expiresAt } : {}),
    };
  });
  return {
    views,
    docks: {
      side: desktop?.summary.side ?? { visible: false },
      bottom: desktop?.summary.bottom ?? { visible: false },
      floating: desktop?.summary.floating ?? [],
      ...(desktop?.summary.maximizedGroupId
        ? { maximizedGroupId: desktop.summary.maximizedGroupId }
        : {}),
    },
    layoutUnreported: desktop === undefined,
  };
}

/** A compact one-line description of a session's views for per-turn agent context. */
export function describeRuntimeUiViews(report: RuntimeUiLayoutReport, maxViews = 8): string {
  if (report.views.length === 0) return "";
  const parts = report.views.slice(0, maxViews).map((view) => {
    const where = view.anchor?.slot ? `card slot "${view.anchor.slot}"` : view.placement;
    return `"${summaryTitle(view.title)}" ${where}${view.dock?.active ? " (active)" : ""} id=${view.instanceId}`;
  });
  const more = report.views.length > maxViews ? `; +${report.views.length - maxViews} more` : "";
  return `Views attached to this session: ${parts.join("; ")}${more}. Call ui.layout.get for the full arrangement.`;
}

/** Titles can come from extensions; keep them to one short, inert line. */
function summaryTitle(title: string): string {
  const flat = title
    .replace(/[\r\n\t"[\]<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat || "Untitled view";
}
