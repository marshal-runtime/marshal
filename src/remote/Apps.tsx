/* eslint-disable better-tailwindcss/no-unknown-classes -- Remote styles live in remote.css. */
/* eslint-disable react/only-export-components -- the apps hook, list, and pane share one mobile surface */
import {
  RUNTIME_UI_PLACEMENT,
  RUNTIME_UI_USER_SCOPE,
  type RuntimeUiPlacementApplication,
} from "@common/runtime-ui";
import { useEffect, useRef } from "react";

import { ChevronLeft, Puzzle } from "../components/icons";
import {
  MarshalRuntimeEditorContext,
  type MarshalRuntimeEditor,
} from "../features/runtime-ui/RuntimeEditor";
import { RuntimeUiInstanceFrame } from "../features/runtime-ui/RuntimeUiHost";
import { useRuntimeUiPlacementSnapshot } from "../features/runtime-ui/RuntimeUiPlacements";
import { RuntimeUiContext } from "../features/runtime-ui/runtimeUiContext";
import { useRuntimeUiScope } from "../features/runtime-ui/useRuntimeUi";

export interface RemoteAppOwner {
  readonly extensionId: string;
  readonly applicationId: string;
}

// Packaged apps never mount the debugger editor; satisfy the renderer's editor
// contract with an inert read-only fallback instead of shipping Monaco to the
// phone.
export const remoteRuntimeEditor: MarshalRuntimeEditor = {
  id: "remote-readonly",
  SourceEditor: ({ source }) => (
    <pre className="remote-source-fallback">{source.content ?? source.path}</pre>
  ),
};

/**
 * Published nav applications that declare a mobile view (Omer's mobile-UI
 * contract: presence is the signal — an extension that provides a mobile view
 * is listed; one that does not simply is not).
 */
export function useRemoteApplications(): readonly RuntimeUiPlacementApplication[] {
  const snapshot = useRuntimeUiPlacementSnapshot(RUNTIME_UI_USER_SCOPE);
  return (
    snapshot.placements
      .find((placement) => placement.metadata.id === RUNTIME_UI_PLACEMENT.NAV_PRIMARY)
      ?.applications.filter((application) => application.viewports?.includes("mobile")) ?? []
  );
}

export function RemoteAppsList({
  applications,
  onOpen,
}: {
  readonly applications: readonly RuntimeUiPlacementApplication[];
  readonly onOpen: (owner: RemoteAppOwner) => void;
}) {
  if (applications.length === 0) {
    return (
      <p className="remote-list-note">
        No extension apps with a phone view yet. Apps appear here when an installed extension
        publishes one.
      </p>
    );
  }
  return (
    <nav className="remote-conversation-list" aria-label="Extension apps">
      {applications.map((application) => (
        <button
          key={`${application.extensionId}:${application.applicationId}`}
          className="remote-app-link"
          onClick={() =>
            onOpen({
              extensionId: application.extensionId,
              applicationId: application.applicationId,
            })
          }
        >
          <strong>
            <Puzzle size={18} aria-hidden="true" /> {application.title}
          </strong>
          <small>{application.description || application.extensionId}</small>
        </button>
      ))}
    </nav>
  );
}

export function RemoteAppPane({
  extensionId,
  applicationId,
  onBack,
}: RemoteAppOwner & { readonly onBack: () => void }) {
  const model = useRuntimeUiScope(RUNTIME_UI_USER_SCOPE);
  const applications = useRemoteApplications();
  const application = applications.find(
    (candidate) =>
      candidate.extensionId === extensionId && candidate.applicationId === applicationId,
  );
  const instance = model.instances.find(
    (candidate) =>
      candidate.owner.extensionId === extensionId &&
      candidate.owner.applicationId === applicationId,
  );
  const activating = useRef(false);
  const resync = model.resync;
  useEffect(() => {
    if (model.status !== "ready" || instance || !application || activating.current) return;
    activating.current = true;
    void (async () => {
      try {
        const result = await window.runtimeUiAPI?.activatePlacement({
          ...RUNTIME_UI_USER_SCOPE,
          placementId: RUNTIME_UI_PLACEMENT.NAV_PRIMARY,
          extensionId,
          applicationId,
          idempotencyKey: `remote-navigation:${crypto.randomUUID()}`,
        });
        if (result?.success) await resync();
      } finally {
        // Allow one retry per pane mount after a reconnect-triggered resync.
        activating.current = false;
      }
    })();
  }, [model.status, instance, application, extensionId, applicationId, resync]);
  return (
    <section className="remote-app-pane" aria-label={application?.title ?? "Extension app"}>
      <header className="remote-header">
        <button aria-label="Back to chats" onClick={onBack}>
          <ChevronLeft size={22} />
        </button>
        <div>
          <strong>{application?.title ?? "Extension app"}</strong>
          <small>{application?.extensionId ?? extensionId}</small>
        </div>
      </header>
      {!application && model.status === "ready" ? (
        <p className="remote-list-note" role="alert">
          This app no longer publishes a phone view. Open it on your Mac.
        </p>
      ) : instance ? (
        <MarshalRuntimeEditorContext value={remoteRuntimeEditor}>
          <RuntimeUiContext value={model}>
            <RuntimeUiInstanceFrame
              instances={[instance]}
              className="remote-app-frame"
              contentClassName="h-full"
              testId={`remote-app-${applicationId}`}
            />
          </RuntimeUiContext>
        </MarshalRuntimeEditorContext>
      ) : (
        <p className="remote-list-note" role="status">
          {model.error ? model.error.message : "Opening…"}
        </p>
      )}
    </section>
  );
}
