/* eslint-disable react/only-export-components -- gate helpers and the missing-variant chrome share one viewport contract */
import type { RuntimeUiInstance } from "@common/runtime-ui";
import {
  DESKTOP_ONLY_VIEWPORTS,
  MARSHAL_UI_VIEWPORTS_METADATA_KEY,
  parseUiViewports,
  type MarshalUiViewport,
} from "@common/runtime-ui-viewports";
import { useState } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";

/** The viewport of the client this renderer is running in. */
export function clientUiViewport(): MarshalUiViewport {
  return window.marshalRemote ? "mobile" : "desktop";
}

/**
 * Resolve a surface's declared viewports; undeclared surfaces are
 * desktop-only. Declaration is deliberate (publication metadata / payload
 * member) — never inferred from document markup, which the runtime stamps
 * with a responsive viewport meta on every compiled artifact wrapper.
 */
export function resolvedUiViewports(declared: unknown): ReadonlySet<MarshalUiViewport> {
  return parseUiViewports(declared) ?? DESKTOP_ONLY_VIEWPORTS;
}

const AUTHORED_UI_OWNER_ID = "marshal.react-ui";

function viewportName(viewport: MarshalUiViewport): string {
  return viewport === "mobile" ? "phone" : "desktop";
}

function requestPrompt(instance: RuntimeUiInstance, missing: MarshalUiViewport): string {
  const owner = instance.owner;
  const opened = `I tried to open it on my ${viewportName(missing)} and it has no ${viewportName(missing)} view.`;
  if (owner.extensionId === AUTHORED_UI_OWNER_ID) {
    const layout =
      missing === "mobile"
        ? "a phone layout (~390px wide, single column, touch-sized controls)"
        : "a desktop layout that uses the wider space";
    return (
      `Please add a ${viewportName(missing)} view to the UI you showed me (instance ${instance.instanceId}). ${opened} ` +
      `Call runtimeShowUi {instanceId: "${instance.instanceId}", views: {${missing}: {tsx: <component>}}} with ${layout}. ` +
      `The existing view, title, and props are kept.`
    );
  }
  const target =
    missing === "mobile"
      ? "a mobile variant (phone-sized viewport, ~390px wide)"
      : "a desktop variant";
  return (
    `Please write ${target} of the UI component you published as ` +
    `${owner.extensionId}/${owner.applicationId} (render ${instance.content.kind === "application" ? instance.content.renderId : owner.applicationId}, ` +
    `instance ${instance.instanceId}). ${opened} ` +
    `Republish the component and declare the viewports it serves on the artifact ` +
    `(${MARSHAL_UI_VIEWPORTS_METADATA_KEY}: ["${missing}"] — or ["mobile", "desktop"] if you make it responsive).`
  );
}

/**
 * Honest missing-variant state for session-owned UI (Omer's mobile-UI
 * contract): never render a component on a viewport it does not declare;
 * show an error in its place, with a request that re-engages the OWNING
 * session's agent to write the missing variant. Extension-owned (user /
 * workspace scoped) applications never reach this — for extensions, presence
 * in the client's nav (declared viewports on the publication metadata) is the
 * signal, and their variants come from extension updates, not session agents.
 */
export function MissingViewportVariant({
  instance,
  viewport,
}: {
  readonly instance: RuntimeUiInstance;
  readonly viewport: MarshalUiViewport;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const owningSessionId = instance.owner.applicationScope ? undefined : instance.owner.sessionId;
  const request = async () => {
    if (!owningSessionId) return;
    setState("sending");
    try {
      // The phone's remote policy only accepts sends that carry a client message id.
      const result = await window.copilotAPI.send(
        requestPrompt(instance, viewport),
        owningSessionId,
        undefined,
        crypto.randomUUID(),
      );
      setState(result?.success ? "sent" : "failed");
    } catch {
      setState("failed");
    }
  };
  return (
    <div
      role="alert"
      data-testid="runtime-ui-viewport-gate"
      className="flex flex-col items-start gap-2 rounded-md border border-border bg-muted/30 p-4 text-sm"
    >
      <p>
        This UI has no {viewportName(viewport)} view yet — it was built for the{" "}
        {viewport === "mobile" ? "desktop" : "phone"}.
      </p>
      {owningSessionId ? (
        state === "sent" ? (
          <p role="status" className="text-muted-foreground">
            Asked the session’s agent for a {viewportName(viewport)} view. It will appear here when
            it is ready.
          </p>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={state === "sending"}
              onClick={() => void request()}
            >
              {state === "sending"
                ? "Asking…"
                : `Ask for a ${viewportName(viewport)} view for this UI`}
            </Button>
            {state === "failed" && (
              <p role="alert" className="text-destructive">
                The request could not be sent. Check the session and try again.
              </p>
            )}
          </>
        )
      ) : (
        <p className="text-muted-foreground">
          The extension that owns this app has not published a {viewportName(viewport)} view.
        </p>
      )}
    </div>
  );
}
