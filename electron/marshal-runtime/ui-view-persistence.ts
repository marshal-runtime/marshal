import { randomUUID } from "node:crypto";

import { createLogger } from "../../common/marshal-logger";
import type { RuntimeUiEvent, RuntimeUiScope } from "../../common/runtime-ui";
import {
  buildRuntimeUiLayoutReport,
  describeRuntimeUiViews,
  dockRegionForSurface,
  surfaceForDockRegion,
  type RuntimeUiDesktopLayout,
  type RuntimeUiLayoutReport,
  type RuntimeUiLayoutSaveRequest,
  type RuntimeUiUserMove,
} from "../../common/runtime-ui-layout";
import type { MarshalRuntimeUiController } from "./ui-controller";
import type { RuntimeUiViewStore } from "./ui-view-store";

const log = createLogger("RuntimeUiViews");
const SAVE_DELAY_MS = 300;
const RESTORE_SESSION_LIMIT = 100;
const RESTORE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_LAYOUT_BYTES = 512 * 1024;

export interface RuntimeUiViewPersistence {
  readonly getDesktopLayout: (scope: RuntimeUiScope) => RuntimeUiDesktopLayout | undefined;
  readonly saveDesktopLayout: (request: RuntimeUiLayoutSaveRequest) => Promise<void>;
  readonly report: (scope: RuntimeUiScope) => RuntimeUiLayoutReport;
  /** One-line summary of a session's views for the per-turn prompt context. */
  readonly describeSession: (sessionId: string) => string | undefined;
  readonly flush: () => void;
  readonly dispose: () => void;
}

function sessionScope(scope: RuntimeUiScope): scope is RuntimeUiScope & { sessionId: string } {
  return !scope.applicationScope && typeof scope.sessionId === "string" && !!scope.sessionId;
}

function isPersistedChange(event: RuntimeUiEvent): boolean {
  switch (event.type) {
    case "instance-opened":
    case "instance-updated":
    case "instance-focused":
      return !event.instance.transient;
    case "instance-closed":
    case "owner-invalidated":
      return true;
    default:
      return false;
  }
}

/**
 * Keeps a session's docked tabs and permanent cards alive across restarts and
 * records the desktop dock arrangement so the agent can read it.
 */
export function attachRuntimeUiViewPersistence(
  controller: MarshalRuntimeUiController,
  store: RuntimeUiViewStore,
): RuntimeUiViewPersistence {
  const desktopLayouts = new Map<string, RuntimeUiDesktopLayout>();
  const pending = new Map<
    string,
    { scope: RuntimeUiScope; timer: ReturnType<typeof setTimeout> }
  >();
  const workspaceBySession = new Map<string, string>();

  for (const stored of store.recent(RESTORE_SESSION_LIMIT, RESTORE_MAX_AGE_MS)) {
    workspaceBySession.set(stored.sessionId, stored.workspaceName);
    if (stored.desktop) desktopLayouts.set(stored.sessionId, stored.desktop);
    try {
      controller.restore(stored.instances);
    } catch (error) {
      log.warn("Failed to restore saved views", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const writeNow = (scope: RuntimeUiScope & { sessionId: string }) => {
    try {
      store.writeInstances(scope.sessionId, scope.workspaceName, controller.scopeInstances(scope));
    } catch (error) {
      log.warn("Failed to save session views", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const schedule = (scope: RuntimeUiScope) => {
    if (!sessionScope(scope)) return;
    const existing = pending.get(scope.sessionId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      pending.delete(scope.sessionId);
      writeNow(scope);
    }, SAVE_DELAY_MS);
    timer.unref?.();
    pending.set(scope.sessionId, { scope, timer });
  };

  const unsubscribe = controller.subscribe((event) => {
    if ("scope" in event && sessionScope(event.scope)) {
      workspaceBySession.set(event.scope.sessionId, event.scope.workspaceName);
    }
    if (isPersistedChange(event)) schedule(event.scope);
  });
  const report = (scope: RuntimeUiScope) =>
    buildRuntimeUiLayoutReport(
      controller.scopeInstances(scope),
      sessionScope(scope) ? desktopLayouts.get(scope.sessionId) : undefined,
    );

  const flush = () => {
    for (const { scope, timer } of pending.values()) {
      clearTimeout(timer);
      if (sessionScope(scope)) writeNow(scope);
    }
    pending.clear();
  };

  return {
    getDesktopLayout: (scope) =>
      sessionScope(scope) ? desktopLayouts.get(scope.sessionId) : undefined,
    report,
    describeSession: (sessionId) => {
      const workspaceName = workspaceBySession.get(sessionId);
      if (!workspaceName) return undefined;
      return describeRuntimeUiViews(report({ sessionId, workspaceName })) || undefined;
    },
    saveDesktopLayout: async (request) => {
      if (!sessionScope(request)) throw new Error("Layouts are saved per chat session.");
      const desktop: RuntimeUiDesktopLayout = {
        version: 1,
        savedAt: new Date().toISOString(),
        dockview: request.layout.dockview,
        summary: request.layout.summary,
      };
      if (Buffer.byteLength(JSON.stringify(desktop), "utf8") > MAX_LAYOUT_BYTES) {
        throw new Error("The saved layout is too large.");
      }
      desktopLayouts.set(request.sessionId, desktop);
      store.writeDesktopLayout(request.sessionId, request.workspaceName, desktop);
      await applyUserMoves(controller, request, request.moves ?? []);
    },
    flush,
    dispose: () => {
      flush();
      unsubscribe();
    },
  };
}

/**
 * Records the tabs the user dragged onto the matching surface. A move whose
 * `fromSurface` no longer matches is stale (the agent moved the view since)
 * and is dropped.
 */
async function applyUserMoves(
  controller: MarshalRuntimeUiController,
  scope: RuntimeUiScope,
  moves: readonly RuntimeUiUserMove[],
): Promise<void> {
  const instances = new Map(
    controller.scopeInstances(scope).map((instance) => [instance.instanceId, instance]),
  );
  for (const move of moves) {
    const instance = instances.get(move.instanceId);
    if (!instance || instance.surface !== move.fromSurface) continue;
    if (dockRegionForSurface(instance.surface) === undefined) continue;
    if (dockRegionForSurface(instance.surface) === move.region) continue;
    // eslint-disable-next-line no-await-in-loop -- moves apply in order; each emits its own event
    const result = await controller.focus({
      ...instance.owner,
      instanceId: instance.instanceId,
      surface: surfaceForDockRegion(move.region),
      preserveFocus: true,
      idempotencyKey: `layout-move-${randomUUID()}`,
    });
    if (!result.ok) {
      log.warn("Failed to record a layout move", { code: result.error.code });
    }
  }
}
