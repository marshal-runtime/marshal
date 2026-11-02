import { createLogger } from "@common/marshal-logger";
import type { RuntimeUiInstance, RuntimeUiJsonValue, RuntimeUiScope } from "@common/runtime-ui";
import { dockRegionForSurface, type RuntimeUiUserMove } from "@common/runtime-ui-layout";
import type { DockviewApi, SerializedDockview } from "dockview-react";

import { summarizeLayout } from "./dockLayout";
import type { DockReconciler } from "./dockReconciler";

const log = createLogger("SessionDock");

type JsonObject = { readonly [key: string]: RuntimeUiJsonValue };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A saved layout is only handed to dockview when it has dockview's top-level shape. */
export function isSerializedDockview(value: unknown): value is SerializedDockview {
  return isJsonObject(value) && isJsonObject(value.grid) && isJsonObject(value.panels);
}

/**
 * Sends the arrangement to the host. Tabs sitting in a region other than
 * their surface's were dragged there by the user, so they travel as explicit
 * moves stamped with the surface they left.
 */
export function saveDockLayout(
  api: DockviewApi,
  scope: RuntimeUiScope,
  instances: ReadonlyMap<string, RuntimeUiInstance>,
  reconciler: DockReconciler,
): void {
  const bridge = window.runtimeUiAPI;
  if (!bridge?.saveLayout) return;
  // Round-trip drops undefined members so the layout is plain JSON for IPC.
  const dockview: unknown = JSON.parse(JSON.stringify(api.toJSON()));
  if (!isJsonObject(dockview)) return;
  const summary = summarizeLayout(api);
  const moves: RuntimeUiUserMove[] = [];
  for (const placement of summary.placements) {
    const instance = instances.get(placement.instanceId);
    if (
      instance &&
      reconciler.isSettled(instance) &&
      dockRegionForSurface(instance.surface) !== placement.region
    ) {
      moves.push({
        instanceId: instance.instanceId,
        fromSurface: instance.surface,
        region: placement.region,
      });
    }
  }
  void bridge
    .saveLayout({ ...scope, layout: { dockview, summary }, ...(moves.length ? { moves } : {}) })
    .then((result) => {
      if (!result.success) log.warn(`layout save failed: ${result.error.code}`);
    })
    .catch(() => log.warn("layout save failed"));
}
