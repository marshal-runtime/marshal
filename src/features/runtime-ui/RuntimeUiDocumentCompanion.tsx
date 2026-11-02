import { runtimeUiScopeKey, type RuntimeUiInstance } from "@common/runtime-ui";
import { use, useMemo, type ReactNode } from "react";

import { RuntimeUiContext } from "./runtimeUiContext";
import { RuntimeUiDockScopeContext } from "./runtimeUiDockScope";
import { RuntimeUiPanelSurface } from "./RuntimeUiHost";
import { RuntimeUiSelectedSessionContext } from "./RuntimeUiSessionSelection";
import { useRuntimeUiScope } from "./useRuntimeUi";

/** Keep native source evidence visible beside a workspace application. */
export function RuntimeUiDocumentCompanion({
  instance,
  children,
}: {
  readonly instance: RuntimeUiInstance;
  readonly children: ReactNode;
}) {
  const selected = use(RuntimeUiSelectedSessionContext);
  const eligible =
    (instance.owner.applicationScope !== undefined || instance.owner.sessionId !== undefined) &&
    instance.content.kind === "application" &&
    instance.content.descriptor.hostFeatures?.includes("workspace") === true;
  const dockScopeKey = use(RuntimeUiDockScopeContext);
  const sessionId = selected?.sessionId ?? instance.owner.sessionId;
  const workspaceName = selected?.workspaceName ?? instance.owner.workspaceName;
  // Inside the dock, the dock's own session already shows its documents as side tabs.
  const docked =
    sessionId !== undefined &&
    dockScopeKey !== null &&
    dockScopeKey === runtimeUiScopeKey({ sessionId, workspaceName });
  const scope = useMemo(
    () => (eligible && sessionId && !docked ? { sessionId, workspaceName } : null),
    [docked, eligible, sessionId, workspaceName],
  );
  const model = useRuntimeUiScope(scope);
  const documents = model.bySurface.panel.filter((item) => item.content.kind === "file");
  if (!eligible || docked) return children;
  // Stable ancestry preserves iframe state and live transport as evidence opens.
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      {documents.length > 0 && (
        <RuntimeUiContext value={{ ...model, bySurface: { ...model.bySurface, panel: documents } }}>
          <RuntimeUiPanelSurface />
        </RuntimeUiContext>
      )}
    </div>
  );
}
