import {
  RUNTIME_UI_SURFACES,
  type RuntimeUiSurface,
  type RuntimeUiViewOptions,
} from "../../common/runtime-ui";
import {
  isRuntimeUiPlacementName,
  RUNTIME_UI_PLACEMENT_NAMES,
  surfaceForPlacement,
} from "../../common/runtime-ui-layout";

/** Capability-schema properties shared by every call that places a view. */
export const VIEW_OPTION_PROPERTIES = {
  title: { type: "string", minLength: 1, maxLength: 256 },
  slot: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,64}$" },
  afterMessageId: { type: "string", minLength: 1, maxLength: 256 },
  timeoutMs: { type: "integer", minimum: 1_000, maximum: 86_400_000 },
} as const;

export const PLACEMENT_PROPERTY = {
  placement: { enum: RUNTIME_UI_PLACEMENT_NAMES },
} as const;

export const PLACEMENT_DESCRIPTION =
  "Pass placement to choose where the view goes: chat-tab (a tab beside Chat), side (the right dock), bottom (the dock under the chat), floating (a movable window), card (a permanent card in the conversation; add slot to render inside your message at a <!--ui:<slot>--> line you write in your final reply after this call, or afterMessageId), transient (a floating card above the chat that is not part of the conversation and closes when you close it, the user dismisses it, or timeoutMs passes), or fullscreen. Opening never replaces another view; every view becomes its own tab or card.";

export interface ParsedPlacement {
  readonly surface: RuntimeUiSurface;
  readonly options: RuntimeUiViewOptions;
}

/**
 * Resolves `placement` (preferred) or the legacy `surface` plus the card and
 * transient options into a surface and view options. `fallbackTransient`
 * decides what a bare inline card means for the calling capability.
 */
export function parsePlacementInput(
  value: Readonly<Record<string, unknown>>,
  options: { readonly fallbackSurface?: RuntimeUiSurface; readonly fallbackTransient: boolean },
): ParsedPlacement {
  const placement = value.placement;
  if (placement !== undefined && !isRuntimeUiPlacementName(placement)) {
    throw new TypeError(
      `Runtime UI placement must be one of: ${RUNTIME_UI_PLACEMENT_NAMES.join(", ")}.`,
    );
  }
  const legacySurface = RUNTIME_UI_SURFACES.find((surface) => surface === value.surface);
  if (value.surface !== undefined && !legacySurface) {
    throw new TypeError("Runtime UI surface is invalid.");
  }
  const surface =
    (placement ? surfaceForPlacement(placement) : undefined) ??
    legacySurface ??
    options.fallbackSurface;
  if (!surface) throw new TypeError("Runtime UI placement or surface is required.");

  const slot = optionalString(value.slot, "slot");
  const afterMessageId = optionalString(value.afterMessageId, "afterMessageId");
  const title = optionalString(value.title, "title");
  const timeoutMs = value.timeoutMs;
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") {
    throw new TypeError("Runtime UI timeoutMs must be a number.");
  }
  const anchored = slot !== undefined || afterMessageId !== undefined;
  const transient =
    surface === "inline-card" &&
    (placement === "transient" ||
      timeoutMs !== undefined ||
      (placement === undefined && !anchored && options.fallbackTransient));
  if (anchored && surface !== "inline-card") {
    throw new TypeError("slot and afterMessageId only apply to card placement.");
  }
  if (timeoutMs !== undefined && !transient) {
    throw new TypeError("timeoutMs only applies to transient placement.");
  }
  return {
    surface,
    options: {
      ...(title ? { title } : {}),
      ...(transient ? { transient: timeoutMs === undefined ? {} : { timeoutMs } } : {}),
      ...(anchored
        ? {
            anchor: {
              ...(slot ? { slot } : {}),
              ...(afterMessageId ? { afterMessageId } : {}),
            },
          }
        : {}),
    },
  };
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Runtime UI ${label} must be a non-empty string.`);
  }
  return value.trim();
}
