import path from "node:path";

import type { CapabilityProvider } from "@marshal/runtime";

import {
  registerRuntimeUiLayoutHandlers,
  type RuntimeUiLayoutPorts,
} from "./ipc/runtime-ui-layout-ipc";
import type { RuntimeApplicationAuthority } from "./marshal-runtime/application-authority";
import type { MarshalRuntimeUiController } from "./marshal-runtime/ui-controller";
import { createRuntimeUiLayoutProvider } from "./marshal-runtime/ui-layout-provider";
import {
  attachRuntimeUiViewPersistence,
  type RuntimeUiViewPersistence,
} from "./marshal-runtime/ui-view-persistence";
import { RuntimeUiViewStore } from "./marshal-runtime/ui-view-store";
import { setRuntimeUiViewsDescriber } from "./runtime-ui-turn-context";

export interface RuntimeUiViews {
  readonly persistence: RuntimeUiViewPersistence;
  /** The `ui.layout.get` / `ui.view.move` capabilities. */
  readonly layoutProvider: CapabilityProvider;
}

/**
 * Wires session views: per-session persistence under `<runtimeRoot>/ui-views`,
 * the agent's layout capabilities, the per-turn views summary, and the
 * desktop layout IPC channels.
 */
export function wireRuntimeUiViews(options: {
  readonly controller: MarshalRuntimeUiController;
  readonly runtimeRoot: string;
  readonly applications: Pick<RuntimeApplicationAuthority, "resolve">;
  readonly ipcHandle: RuntimeUiLayoutPorts["ipcHandle"];
  readonly runtimeReady: () => Promise<void>;
}): RuntimeUiViews {
  const persistence = attachRuntimeUiViewPersistence(
    options.controller,
    new RuntimeUiViewStore(path.join(options.runtimeRoot, "ui-views")),
  );
  setRuntimeUiViewsDescriber(persistence.describeSession);
  registerRuntimeUiLayoutHandlers({
    ipcHandle: options.ipcHandle,
    controller: options.controller,
    persistence,
    runtimeReady: options.runtimeReady,
  });
  return {
    persistence,
    layoutProvider: createRuntimeUiLayoutProvider(
      options.controller,
      persistence,
      options.applications,
    ),
  };
}
