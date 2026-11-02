/* eslint-disable react/only-export-components -- the capture harness ships its component and config parser together */
import {
  RUNTIME_UI_PLACEMENT,
  type RuntimeUiInstance,
  type RuntimeUiScope,
} from "@common/runtime-ui";
import type { MarshalUiViewport } from "@common/runtime-ui-viewports";
import { useEffect, useRef, useState, type RefObject } from "react";

import "../features/runtime-ui";
import {
  MarshalRuntimeEditorContext,
  type MarshalRuntimeEditor,
} from "../features/runtime-ui/RuntimeEditor";
import { RuntimeUiContext } from "../features/runtime-ui/runtimeUiContext";
import { RuntimeUiInstanceFrame } from "../features/runtime-ui/RuntimeUiHost";
import { useRuntimeUiScope } from "../features/runtime-ui/useRuntimeUi";

export type ObserveState = "preparing" | "rendered" | "error";

export interface ObserveConfig {
  readonly mode: "application" | "instance";
  readonly extensionId: string;
  readonly applicationId: string;
  readonly instanceId?: string;
  /** Stable object — built ONCE. useRuntimeUiScope keys its subscription on
   *  the scope identity; a per-render scope loops teardown/resubscribe and the
   *  harness never leaves "preparing" (the first live-demo defect). */
  readonly scope: RuntimeUiScope;
  readonly viewport: MarshalUiViewport;
}

export function parseObserveConfig(search: string): ObserveConfig {
  const params = new URLSearchParams(search);
  const workspaceName = params.get("workspaceName") ?? "marshal";
  const applicationScope = params.get("applicationScope");
  const sessionId = params.get("sessionId");
  const scope: RuntimeUiScope =
    applicationScope === "user" || applicationScope === "workspace"
      ? { applicationScope, workspaceName }
      : sessionId
        ? { sessionId, workspaceName }
        : { applicationScope: "user", workspaceName };
  const instanceId = params.get("instanceId");
  return {
    mode: params.get("mode") === "instance" ? "instance" : "application",
    extensionId: params.get("extensionId") ?? "",
    applicationId: params.get("applicationId") ?? "",
    ...(instanceId ? { instanceId } : {}),
    scope,
    viewport: params.get("viewport") === "mobile" ? "mobile" : "desktop",
  };
}

const observeEditor: MarshalRuntimeEditor = {
  id: "observe-readonly",
  SourceEditor: ({ source }) => <pre>{source.content ?? source.path}</pre>,
};

function setObserveState(state: ObserveState): void {
  document.documentElement.dataset.observeState = state;
}

/**
 * Signals the terminal presentation to the capture pipeline: the application
 * initialized (loading status gone), or an error/gate alert rendered — error
 * states are honest observations. The state rides both the document dataset
 * (read by the capture guard, so a stuck harness can never masquerade as a
 * successful capture) and the ui-observe:ready signal.
 */
function useSettledSignal(
  rootRef: RefObject<HTMLElement | null>,
  failed: boolean,
  createdInstanceId: RefObject<string | null>,
) {
  const signalled = useRef(false);
  useEffect(() => {
    if (signalled.current) return undefined;
    const signal = (state: Exclude<ObserveState, "preparing">) => {
      if (signalled.current) return;
      signalled.current = true;
      setObserveState(state);
      window.uiObserveAPI?.ready({
        state,
        ...(createdInstanceId.current
          ? { instanceId: createdInstanceId.current, created: true }
          : {}),
      });
    };
    if (failed) {
      signal("error");
      return undefined;
    }
    const settled = (): Exclude<ObserveState, "preparing"> | null => {
      const root = rootRef.current;
      if (!root) return null;
      if (root.querySelector("[role=alert]")) return "error";
      const frame = root.querySelector("[data-testid=runtime-ui-packaged-frame]");
      const application = root.querySelector("[data-testid=runtime-ui-application]");
      const loading = root.querySelector("[role=status]");
      return (frame || application) && !loading ? "rendered" : null;
    };
    const initial = settled();
    if (initial) {
      signal(initial);
      return undefined;
    }
    const observer = new MutationObserver(() => {
      const state = settled();
      if (state) signal(state);
    });
    if (rootRef.current)
      observer.observe(rootRef.current, { childList: true, subtree: true, attributes: true });
    return () => observer.disconnect();
  }, [failed, rootRef, createdInstanceId]);
}

export function ObserveApp({ config }: { readonly config: ObserveConfig }) {
  const model = useRuntimeUiScope(config.scope);
  const activating = useRef(false);
  const createdInstanceId = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const resync = model.resync;
  const instance: RuntimeUiInstance | undefined = model.instances.find((candidate) =>
    config.mode === "instance"
      ? candidate.instanceId === config.instanceId
      : candidate.owner.extensionId === config.extensionId &&
        candidate.owner.applicationId === config.applicationId,
  );
  useEffect(() => {
    setObserveState("preparing");
  }, []);
  useEffect(() => {
    if (config.mode !== "application" || model.status !== "ready" || instance || activating.current)
      return;
    activating.current = true;
    void (async () => {
      try {
        const result = await window.runtimeUiAPI?.activatePlacement({
          ...config.scope,
          placementId: RUNTIME_UI_PLACEMENT.NAV_PRIMARY,
          extensionId: config.extensionId,
          applicationId: config.applicationId,
          idempotencyKey: `ui-observe:${crypto.randomUUID()}`,
        });
        if (result?.success) {
          // No prior instance existed in this scope (that is why we activated),
          // so a successful activation CREATED this instance; the window
          // lifecycle closes it on teardown.
          createdInstanceId.current = result.value.instance?.instanceId ?? null;
          await resync();
        } else setError(result?.error.message ?? "The application could not be activated.");
      } catch (activationError) {
        // Never swallow: a silent failure leaves the harness in "preparing"
        // forever and turns every capture into a lie.
        setError(
          activationError instanceof Error
            ? activationError.message
            : "The application could not be activated.",
        );
      }
    })();
  }, [config, model.status, instance, resync]);
  const instanceMissing = config.mode === "instance" && model.status === "ready" && !instance;
  const failureMessage =
    error ??
    model.error?.message ??
    (instanceMissing
      ? "The requested component instance is not present in the observed scope. It may have been closed."
      : null);
  useSettledSignal(rootRef, Boolean(failureMessage), createdInstanceId);
  return (
    <div
      ref={rootRef}
      data-app-root
      data-observe-viewport={config.viewport}
      style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column" }}
      className="bg-background text-foreground"
    >
      {instance ? (
        <MarshalRuntimeEditorContext value={observeEditor}>
          <RuntimeUiContext value={model}>
            <RuntimeUiInstanceFrame
              instances={[instance]}
              className="min-h-0 flex-1"
              contentClassName="h-full"
              testId="ui-observe-frame"
            />
          </RuntimeUiContext>
        </MarshalRuntimeEditorContext>
      ) : failureMessage ? (
        <p role="alert" className="p-4 text-sm">
          {failureMessage}
        </p>
      ) : (
        <p role="status" className="p-4 text-sm">
          Preparing observation…
        </p>
      )}
    </div>
  );
}
