import type { RuntimeUiInstance, RuntimeUiJsonValue } from "@common/runtime-ui";
import type { UiApplicationManifest, UiDisplayMode } from "@marshal/runtime/ui";
import { lazy, Suspense, useContext, useMemo } from "react";

import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import { MarkdownRenderer } from "@/plugins/streamdown-config";

import { declarativeRuntimeUiRenderer } from "./DeclarativeRuntimeUiRenderer";
import { DocumentLinkScope } from "./documentNavigation";
import { PackagedRuntimeUiRenderer } from "./PackagedRuntimeUiRenderer";
import { MarshalRuntimeEditorContext, type MarshalRuntimeEditor } from "./RuntimeEditor";
import { createRuntimeUiApplicationHost } from "./RuntimeUiApplicationHost";
import { getRuntimeUiApplicationRenderer } from "./RuntimeUiApplicationRegistry";
import {
  RuntimeUiRefreshImagesContext,
  RuntimeUiSelectedImagesContext,
} from "./RuntimeUiImageSelection";
import {
  RuntimeUiSelectedSessionContext,
  RuntimeUiSessionOpenedContext,
  RuntimeUiSessionPickerContext,
} from "./RuntimeUiSessionSelection";

// Document previews bring their own editor and diagram dependencies. Loading
// a chat or packaged application should not wait for those downloads.
const FilePreview = lazy(() =>
  import("@/features/create/FilePreview").then((module) => ({ default: module.FilePreview })),
);

function preferredDisplayMode(instance: RuntimeUiInstance): UiDisplayMode {
  if (instance.surface === "fullscreen") return "fullscreen";
  if (instance.surface === "panel") return "pip";
  return "inline";
}

function resolvedDisplayMode(
  instance: RuntimeUiInstance,
  descriptor: UiApplicationManifest,
): UiDisplayMode | undefined {
  const preferred = preferredDisplayMode(instance);
  return descriptor.presentationModes.includes(preferred)
    ? preferred
    : descriptor.presentationModes[0];
}

function safeJson(value: { readonly [key: string]: RuntimeUiJsonValue } | undefined): string {
  if (!value) return "{}";
  return JSON.stringify(value, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export function RuntimeUiRenderer({
  instance,
  editor: explicitEditor,
  layout = "natural",
}: {
  readonly instance: RuntimeUiInstance;
  readonly editor?: MarshalRuntimeEditor;
  /**
   * Declared by the embedder, never inferred from instance.surface: "fill"
   * hands the packaged-app iframe a continuous min-h-0 flex chain (only
   * correct when the caller's own ancestor chain is flex with a definite/flex
   * height, as RuntimeUiInstanceFrame's bounded content box is). Every other
   * embedding — including block-flow contexts like SessionActivityPanel's
   * evidence detail — must stay "natural" to keep the packaged app's floor.
   */
  readonly layout?: "fill" | "natural";
}) {
  const injectedEditor = useContext(MarshalRuntimeEditorContext);
  const editor = explicitEditor ?? injectedEditor;
  const selectedSession = useContext(RuntimeUiSelectedSessionContext);
  const selectedImages = useContext(RuntimeUiSelectedImagesContext);
  const refreshImages = useContext(RuntimeUiRefreshImagesContext);
  const sessionPicker = useContext(RuntimeUiSessionPickerContext);
  const onSessionOpened = useContext(RuntimeUiSessionOpenedContext);
  const application = instance.content.kind === "application" ? instance.content : undefined;
  const renderer = application ? getRuntimeUiApplicationRenderer(application.renderId) : undefined;
  const host = useMemo(() => {
    if (!application || !editor) return undefined;
    const created = createRuntimeUiApplicationHost(
      instance,
      editor,
      selectedSession,
      selectedImages,
      refreshImages,
      onSessionOpened ?? undefined,
    );
    return sessionPicker && instance.owner.applicationScope !== undefined
      ? { ...created, requestSessionPicker: sessionPicker.summon }
      : created;
  }, [
    application,
    editor,
    instance,
    selectedSession,
    selectedImages,
    refreshImages,
    sessionPicker,
    onSessionOpened,
  ]);
  if (instance.content.kind === "file") {
    return (
      <DocumentLinkScope scope={instance.owner} basePath={instance.content.path}>
        <Suspense fallback={<p role="status">Loading document…</p>}>
          <FilePreview
            key={instance.content.path}
            filePath={instance.content.path}
            readCapability={instance.content.readCapability}
            revealLine={instance.content.revealLine}
            annotations={instance.content.annotations}
          />
        </Suspense>
      </DocumentLinkScope>
    );
  }
  if (instance.content.kind === "text") {
    return <p className="text-sm/6 whitespace-pre-wrap">{instance.content.text}</p>;
  }
  if (instance.content.kind === "markdown") {
    return (
      <div className="min-w-0 text-sm/6" data-testid="runtime-ui-markdown">
        <DocumentLinkScope scope={instance.owner}>
          <MarkdownRenderer>{instance.content.markdown}</MarkdownRenderer>
        </DocumentLinkScope>
      </div>
    );
  }
  const { descriptor, state, renderId } = instance.content;
  const resolvedRenderer =
    renderer ?? (state && "document" in state ? declarativeRuntimeUiRenderer : undefined);
  if (resolvedRenderer && host) {
    return (
      <div
        className="flex min-h-0 flex-col"
        data-testid="runtime-ui-application"
        data-render-id={renderId}
      >
        {resolvedRenderer({ instance, host })}
      </div>
    );
  }
  if (host && instance.content.resource.mimeType.split(";")[0].trim() === "text/html") {
    return <PackagedRuntimeUiRenderer instance={instance} host={host} layout={layout} />;
  }
  const displayMode = resolvedDisplayMode(instance, descriptor);
  return (
    <div
      className="flex min-h-0 flex-col gap-4"
      data-testid="runtime-ui-application"
      data-render-id={renderId}
    >
      <section aria-labelledby={`${instance.instanceId}-presentation`}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`${instance.instanceId}-presentation`} className="text-sm font-medium">
            Application contract
          </h3>
          {displayMode && <Badge variant="secondary">{displayMode}</Badge>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Declared modes: {descriptor.presentationModes.join(", ") || "none"}
        </p>
      </section>

      <section aria-labelledby={`${instance.instanceId}-actions`}>
        <h3 id={`${instance.instanceId}-actions`} className="text-sm font-medium">
          Declared actions
        </h3>
        {descriptor.actions.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No actions declared.</p>
        ) : (
          <ul className="mt-2 grid gap-2">
            {descriptor.actions.map((action) => (
              <li
                key={`${action.id}:${action.version}`}
                className="rounded-md border border-border bg-muted/30 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{action.title ?? action.id}</p>
                    {action.description && (
                      <p className="mt-1 text-xs text-muted-foreground">{action.description}</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {action.target.kind === "capability"
                        ? `Capability: ${action.target.capability}`
                        : "Reviewed module target"}{" "}
                      · {action.risk}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled
                    aria-label={`${action.title ?? action.id} is unavailable in this host`}
                    title="Application action dispatch is not exposed by the current typed host API."
                  >
                    Run
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${instance.instanceId}-tools`}>
        <h3 id={`${instance.instanceId}-tools`} className="text-sm font-medium">
          Declared tools
        </h3>
        {descriptor.tools.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No tools declared.</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {descriptor.tools.map((tool) => (
              <li key={tool.id}>
                <Badge variant="outline">{tool.name}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${instance.instanceId}-state-contract`}>
        <h3 id={`${instance.instanceId}-state-contract`} className="text-sm font-medium">
          State contract
        </h3>
        <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
          <div className="rounded-md border border-border p-2">
            <dt className="font-medium">Local state</dt>
            <dd className="mt-1 text-muted-foreground">
              {descriptor.localState
                ? `${descriptor.localState.scope} · schema ${descriptor.localState.schemaVersion}`
                : "Not declared"}
            </dd>
          </div>
          <div className="rounded-md border border-border p-2">
            <dt className="font-medium">Authoritative state</dt>
            <dd className="mt-1 break-all text-muted-foreground">
              {descriptor.authoritativeState
                ? `${descriptor.authoritativeState.capability} · ${descriptor.authoritativeState.resourceId} · ${descriptor.authoritativeState.version}`
                : "Not declared"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="min-h-0" aria-labelledby={`${instance.instanceId}-state`}>
        <h3 id={`${instance.instanceId}-state`} className="text-sm font-medium">
          Render state
        </h3>
        <pre
          className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap"
          data-testid="runtime-ui-state-inspector"
        >
          {safeJson(state)}
        </pre>
      </section>
    </div>
  );
}
