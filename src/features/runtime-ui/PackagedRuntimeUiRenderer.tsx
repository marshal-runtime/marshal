import { useQuery } from "@tanstack/react-query";
import { useContext, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import { cn } from "@/lib/marshal-class-names";

import { createPackagedUiBridge } from "./packagedUiBridge";
import { createPackagedUiDocument } from "./packagedUiDocument";
import type { RuntimeUiApplicationRendererProps } from "./RuntimeUiApplicationRegistry";
import { RuntimeUiFrameChromeContext } from "./runtimeUiFrameChrome";
import { RuntimeUiLoadingSkeleton } from "./RuntimeUiLoadingSkeleton";
import {
  MissingViewportVariant,
  clientUiViewport,
  resolvedUiViewports,
} from "./ViewportVariantGate";

function PackagedFrame({
  html,
  host,
  instance,
  layout,
}: RuntimeUiApplicationRendererProps & {
  readonly html: string;
  readonly layout: "fill" | "natural";
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<ReturnType<typeof createPackagedUiBridge> | undefined>(undefined);
  const [nonce, setNonce] = useState(() => crypto.randomUUID());
  const [status, setStatus] = useState<{ readonly ready: boolean; readonly error?: string }>({
    ready: false,
  });
  // An authored (nested) component declared no variant for this client's
  // viewport: the bridge mounted an inert notice; trusted chrome offers the
  // request-variant path here, outside the sandboxed document.
  const [missingVariant, setMissingVariant] = useState<"mobile" | "desktop" | null>(null);
  // Fullscreen promotes a PERSISTENT <dialog> wrapper to the top layer via
  // showModal(): the iframe never reparents (top-layer promotion is not a DOM
  // move, so srcdoc state survives), the top layer covers the viewport
  // regardless of overflow/transform ancestors, focus is saved/restored by the
  // dialog element natively, and — unlike Element.requestFullscreen — no
  // transient user activation is needed, so app-initiated requests relayed
  // over postMessage from the sandboxed frame work by default.
  const container = useRef<HTMLDialogElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
  const canOverlay = instance.surface !== "fullscreen";
  const currentHost = useEffectEvent(() => host);
  const currentDisplayMode = useEffectEvent(() =>
    fullscreen && canOverlay ? ("fullscreen" as const) : undefined,
  );
  const applyDisplayMode = useEffectEvent((mode: "inline" | "fullscreen") => {
    if (!canOverlay) return mode === "fullscreen";
    const element = container.current;
    if (!element) return false;
    try {
      if (mode === "fullscreen") {
        if (!element.matches(":modal")) {
          // A dialog carrying the `open` attribute cannot be promoted. Remove
          // the attribute directly instead of close(): close() QUEUES a close
          // event that would fire after promotion and tear the modal back
          // down; attribute removal closes silently.
          element.removeAttribute("open");
          element.showModal();
        }
        setFullscreen(true);
        return true;
      }
      if (element.matches(":modal")) element.close();
      element.setAttribute("open", "");
      setFullscreen(false);
      return true;
    } catch {
      return false;
    }
  });
  const frameChrome = useContext(RuntimeUiFrameChromeContext);
  const reportChrome = useEffectEvent((chrome: "compact" | "hidden") =>
    frameChrome?.report(instance.instanceId, chrome),
  );
  const prepared = useMemo(() => {
    try {
      return { document: createPackagedUiDocument(html, nonce) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Application could not be loaded." };
    }
  }, [html, nonce]);
  useEffect(() => {
    const element = frame.current;
    const document = prepared.document;
    if (!element || !document) return undefined;
    const connection = createPackagedUiBridge({
      frame: element,
      nonce,
      host: currentHost,
      onChromeHint: reportChrome,
      onReady: () => setStatus({ ready: true }),
      onError: (error) => {
        setStatus({ ready: false, error });
        connection.dispose();
        element.removeAttribute("srcdoc");
      },
      displayMode: currentDisplayMode,
      onDisplayModeRequest: applyDisplayMode,
      onContentHeight: (height) => setContentHeight(height),
      onEscape: () => {
        const dialog = container.current;
        if (dialog?.matches(":modal")) dialog.close();
      },
      onViewportVariantMissing: (viewport) => setMissingVariant(viewport),
    });
    bridge.current = connection;
    element.srcdoc = document.srcDoc;
    return () => {
      connection.dispose();
      bridge.current = undefined;
      element.removeAttribute("srcdoc");
      document.dispose();
    };
  }, [prepared, nonce]);
  const error = prepared.error ?? status.error;
  useEffect(
    () => bridge.current?.update(),
    [instance.content, host.selectedSession, host.selectedImages, fullscreen],
  );
  useEffect(() => {
    // The dialog owns every exit path (Escape's native cancel, Exit button,
    // programmatic close): React state follows its close event so the bridge
    // context stays truthful, and the element returns to in-flow rendering.
    const element = container.current;
    if (!element) return undefined;
    const onClose = () => {
      // A close event that arrives while the dialog is (again) modal is stale
      // — a leftover from a pre-promotion transition; applying it would strip
      // the active top layer.
      if (element.matches(":modal")) return;
      element.setAttribute("open", "");
      setFullscreen(false);
    };
    element.addEventListener("close", onClose);
    return () => element.removeEventListener("close", onClose);
  }, []);
  // The embedder declares the layout mode; it is not inferred from
  // instance.surface here. RuntimeUiInstanceFrame's bounded content box
  // (tab/panel/dialog/fullscreen native surfaces) passes "fill": the app
  // shrinks to whatever room the host frame has, even under 320px — a floor
  // there reintroduces the overflow RuntimeUiHost's min-h-0 chain fixes.
  // Every other embedding (inline-card, and block-flow contexts like
  // SessionActivityPanel's evidence detail that have no flex/definite-height
  // ancestor) defaults to "natural", which keeps the min-h-80 floor so the
  // app can't collapse to 0px.
  const boundedFill = layout === "fill";
  const overlayActive = fullscreen && canOverlay;
  // Natural embeds track the application's reported content height so cards
  // up to the cap fit exactly (no nested scrollbar); content taller than the
  // cap scrolls inside the application document by design.
  const naturalHeight =
    !boundedFill && !overlayActive && contentHeight !== undefined
      ? Math.max(160, Math.min(640, Math.ceil(contentHeight)))
      : undefined;
  // Structural resets ride inline so they beat the dialog UA stylesheet in
  // every environment; position/size stay unset while modal so the top layer's
  // own :modal box (fixed, inset 0) governs.
  const structuralStyle = overlayActive
    ? {
        margin: 0,
        border: 0,
        padding: 12,
        width: "100vw",
        height: "100vh",
        maxWidth: "none",
        maxHeight: "none",
        // Inline so the promoted top layer is opaque everywhere: --background
        // is deliberately translucent under vibrancy (src/index.css); the
        // opaque surface token is --background-base.
        background: "var(--background-base)",
        color: "var(--foreground)",
      }
    : ({
        position: "relative",
        margin: 0,
        border: 0,
        padding: 0,
        width: "100%",
        maxWidth: "none",
        maxHeight: "none",
        height: naturalHeight ?? "auto",
      } as const);
  return (
    <dialog
      ref={container}
      open
      aria-label={
        instance.content.kind === "application"
          ? (instance.content.resource.name ?? instance.owner.applicationId)
          : "Extension application"
      }
      data-testid="runtime-ui-app-container"
      data-fullscreen={overlayActive || undefined}
      className={cn(
        "flex flex-col bg-transparent text-inherit",
        overlayActive
          ? "bg-background"
          : boundedFill
            ? "min-h-0 flex-1"
            : naturalHeight === undefined
              ? "min-h-80 flex-1"
              : "flex-1",
      )}
      style={structuralStyle}
    >
      {overlayActive && (
        <div className="mb-2 flex items-center justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            autoFocus
            onClick={() => container.current?.close()}
            aria-label="Exit full screen"
          >
            Exit full screen
          </Button>
        </div>
      )}
      {missingVariant && <MissingViewportVariant instance={instance} viewport={missingVariant} />}
      {error ? (
        <div role="alert" className="flex items-center gap-3 p-4 text-sm">
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setStatus({ ready: false });
              setNonce(crypto.randomUUID());
            }}
          >
            Retry application
          </Button>
        </div>
      ) : !status.ready ? (
        <RuntimeUiLoadingSkeleton label="Loading application…" />
      ) : null}
      <iframe
        ref={frame}
        title={
          instance.content.kind === "application"
            ? (instance.content.resource.name ?? instance.owner.applicationId)
            : "Extension application"
        }
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
        className={cn(
          "w-full flex-1 border-0",
          boundedFill || naturalHeight !== undefined ? "min-h-0" : "min-h-80",
        )}
        data-testid="runtime-ui-packaged-frame"
      />
    </dialog>
  );
}

export function PackagedRuntimeUiRenderer({
  instance,
  host,
  layout = "natural",
}: RuntimeUiApplicationRendererProps & { readonly layout?: "fill" | "natural" }) {
  const uri = instance.content.kind === "application" ? instance.content.resource.uri : "";
  const { readResource } = host;
  // Keyed by owner and URI, not instance: every view of the same render shares
  // one template read (the owner pins the render, its revision and viewports).
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- Owner and URI identify the data; readResource is an injected transport callback.
  const resource = useQuery({
    queryKey: ["runtime-ui", "packaged-resource", instance.owner, uri],
    queryFn: async () => {
      const value = await readResource(uri);
      if (
        value.uri !== uri ||
        value.mimeType.split(";")[0].trim() !== "text/html" ||
        typeof value.text !== "string" ||
        !value.revisionId ||
        !value.integrity
      ) {
        throw new Error("The extension did not publish a versioned HTML application.");
      }
      return value;
    },
    staleTime: Infinity,
    retry: false,
  });
  if (resource.isError) {
    return (
      <div role="alert" className="flex items-center gap-3 p-4 text-sm">
        <span>{resource.error.message}</span>
        <Button variant="outline" size="sm" onClick={() => void resource.refetch()}>
          Reload application
        </Button>
      </div>
    );
  }
  if (!resource.data) return <RuntimeUiLoadingSkeleton label="Loading extension resource…" />;
  // Session-owned components never mount on a viewport their publication does
  // not declare (common/runtime-ui-viewports.ts): the viewer gets an honest
  // error with a request path to the owning session instead of a broken
  // layout. Extension-owned (user/workspace-scope) surfaces are governed by
  // presence in the client's nav — no error card clutter here.
  const viewport = clientUiViewport();
  if (
    !instance.owner.applicationScope &&
    !resolvedUiViewports(resource.data.viewports).has(viewport)
  ) {
    return <MissingViewportVariant instance={instance} viewport={viewport} />;
  }
  return (
    <PackagedFrame
      key={`${resource.data.revisionId}:${resource.data.integrity}`}
      html={resource.data.text!}
      host={{
        ...host,
        invokeCapability: (request) =>
          host.invokeCapability({ ...request, publicationRevisionId: resource.data.revisionId }),
      }}
      instance={instance}
      layout={layout}
    />
  );
}
