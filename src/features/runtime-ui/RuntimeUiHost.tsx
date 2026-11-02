import type { RuntimeUiInstance, RuntimeUiSurface } from "@common/runtime-ui";
import {
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { MessageSquare, PanelBottom } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/marshal-ui/alert";
import { Button } from "@/components/marshal-ui/marshal-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/marshal-class-names";
import { useIsMobile } from "@/shared/hooks/useIsMobile";
import type { SessionMetadata } from "@/types/electron";

import { ConversationCardStore, ConversationCardStoreContext } from "./cards/conversationCardStore";
import { DocumentLinkScope } from "./documentNavigation";
import { RuntimeUiExpandedViewProvider } from "./expanded/RuntimeUiExpandedView";
import { MarshalRuntimeEditorContext, type MarshalRuntimeEditor } from "./RuntimeEditor";
import { isPackagedApplicationInstance } from "./RuntimeUiApplicationRegistry";
import { RuntimeUiContext } from "./runtimeUiContext";
import { RuntimeUiDocumentCompanion } from "./RuntimeUiDocumentCompanion";
import {
  RuntimeUiFrameChromeContext,
  type RuntimeUiFrameChrome,
  type RuntimeUiFrameChromeReporter,
} from "./runtimeUiFrameChrome";
import { RuntimeUiImageSelection } from "./RuntimeUiImageSelection";
import { RuntimeUiNavigationProvider } from "./RuntimeUiNavigation";
import { RuntimeUiPlacementsProvider } from "./RuntimeUiPlacements";
import { RuntimeUiRenderer } from "./RuntimeUiRenderer";
import { RuntimeUiSessionsContext, RuntimeUiSessionSelection } from "./RuntimeUiSessionSelection";
import { type RuntimeUiModel, useRuntimeUi } from "./useRuntimeUi";

function useRuntimeUiModel(): RuntimeUiModel {
  const model = use(RuntimeUiContext);
  if (!model) throw new Error("Runtime UI surfaces must be rendered inside RuntimeUiHost.");
  return model;
}

export function RuntimeUiHost({
  activeSessionId,
  sessions,
  editor,
  fullscreenOverlay = true,
  children,
}: {
  readonly activeSessionId: string | null;
  readonly sessions: readonly SessionMetadata[];
  // TODO(shared-services): replace this explicit editor prop with the shared
  // services injection used by Marshal initialization.
  readonly editor: MarshalRuntimeEditor;
  /** Off where a session dock shows fullscreen views as maximized tabs. */
  readonly fullscreenOverlay?: boolean;
  readonly children: ReactNode;
}) {
  const model = useRuntimeUi({ activeSessionId, sessions });
  const [cardStore] = useState(() => new ConversationCardStore());
  return (
    <RuntimeUiPlacementsProvider scope={model.scope}>
      <MarshalRuntimeEditorContext value={editor}>
        <RuntimeUiContext value={model}>
          <ConversationCardStoreContext value={cardStore}>
            <RuntimeUiSessionsContext value={sessions}>
              <RuntimeUiNavigationProvider>
                <RuntimeUiExpandedViewProvider>
                  <DocumentLinkScope scope={model.scope}>{children}</DocumentLinkScope>
                </RuntimeUiExpandedViewProvider>
              </RuntimeUiNavigationProvider>
              {fullscreenOverlay && <RuntimeUiFullscreenSurface />}
            </RuntimeUiSessionsContext>
          </ConversationCardStoreContext>
          <RuntimeUiErrorNotice />
        </RuntimeUiContext>
      </MarshalRuntimeEditorContext>
    </RuntimeUiPlacementsProvider>
  );
}

function RuntimeUiErrorNotice() {
  const model = useRuntimeUiModel();
  if (!model.error) return null;
  return (
    <Alert
      variant="destructive"
      className="fixed right-4 bottom-4 z-80 w-[min(28rem,calc(100vw-2rem))] shadow-lg"
      role="alert"
      data-testid="runtime-ui-error"
    >
      <AlertTitle>Runtime content could not be updated</AlertTitle>
      <AlertDescription className="mt-1 flex items-end justify-between gap-3">
        <span>{model.error.message}</span>
        <div className="flex shrink-0 gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void model.resync()}>
            Reload
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={model.dismissError}>
            Dismiss
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function RuntimeUiEmptyState({ surface }: { readonly surface: RuntimeUiSurface }) {
  const { status, scope } = useRuntimeUiModel();
  if (!scope) return null;
  return (
    <p className="sr-only" role="status">
      {status === "loading"
        ? `Loading runtime ${surface} content.`
        : `No runtime ${surface} content.`}
    </p>
  );
}

function instanceLabel(instance: RuntimeUiInstance): string {
  // Application publications carry a human title on the resource (authored
  // renders put the render title there); the applicationId is a
  // content-addressed hash for authored renders and only a last resort.
  if (instance.content.kind === "application") {
    const name = instance.content.resource.name?.trim();
    if (name && !/^[0-9a-f]{40,}$/i.test(name)) return name;
  }
  if (/^[0-9a-f]{40,}$/i.test(instance.owner.applicationId)) return "Agent-authored app";
  return instance.owner.applicationId;
}

function moveTarget(
  surface: RuntimeUiSurface,
): { readonly surface: RuntimeUiSurface; readonly label: string } | undefined {
  if (surface === "inline-card" || surface === "panel") {
    return { surface: "bottom-panel", label: "Move to bottom panel" };
  }
  if (surface === "bottom-panel") return { surface: "inline-card", label: "Move to chat" };
  return undefined;
}

function RuntimeUiSwitcher({
  instances,
  selected,
  onSelect,
}: {
  readonly instances: readonly RuntimeUiInstance[];
  readonly selected: RuntimeUiInstance;
  readonly onSelect: (instance: RuntimeUiInstance) => void;
}) {
  if (instances.length < 2) return null;
  return (
    <div className="flex min-w-0 gap-1 overflow-x-auto" role="tablist" aria-label="Runtime content">
      {instances.map((instance) => (
        <Button
          key={instance.instanceId}
          type="button"
          size="xs"
          variant={instance.instanceId === selected.instanceId ? "secondary" : "ghost"}
          role="tab"
          aria-selected={instance.instanceId === selected.instanceId}
          className="max-w-40 shrink-0 truncate"
          onClick={() => onSelect(instance)}
        >
          {instanceLabel(instance)}
        </Button>
      ))}
    </div>
  );
}

export function RuntimeUiInstanceFrame({
  instances,
  className,
  contentClassName,
  dialog = false,
  testId,
}: {
  readonly instances: readonly RuntimeUiInstance[];
  readonly className?: string;
  readonly contentClassName?: string;
  readonly dialog?: boolean;
  readonly testId?: string;
}) {
  const model = useRuntimeUiModel();
  const selected = instances[0];
  const rootRef = useRef<HTMLDivElement>(null);
  // OMR2-2: per-instance hostChrome opt-ins reported by the packaged app at
  // ui/initialize. Keyed by instanceId because this frame can outlive a
  // selection change (workspace tabs reuse one frame across instances).
  const [chromeHints, setChromeHints] = useState<{
    readonly [instanceId: string]: "compact" | "hidden";
  }>({});
  const chromeReporter = useMemo<RuntimeUiFrameChromeReporter>(
    () => ({
      report: (instanceId, chrome) =>
        setChromeHints((previous) => {
          if (chrome === "full") {
            if (!(instanceId in previous)) return previous;
            const next = { ...previous };
            delete next[instanceId];
            return next;
          }
          return previous[instanceId] === chrome ? previous : { ...previous, [instanceId]: chrome };
        }),
    }),
    [],
  );
  useEffect(() => {
    if (!dialog) return undefined;
    const previousFocus = document.activeElement;
    rootRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [dialog]);
  if (!selected) return <RuntimeUiEmptyState surface={instances[0]?.surface ?? "inline-card"} />;
  const requestedChrome = chromeHints[selected.instanceId];
  // Dialog frames (fullscreen overlay) keep a visible close affordance even
  // when the app asks for "hidden" — Escape alone is a keyboard-only trap.
  const chrome: RuntimeUiFrameChrome = !requestedChrome
    ? "full"
    : dialog && requestedChrome === "hidden"
      ? "compact"
      : requestedChrome;
  const pending = model.pending.get(selected.instanceId);
  const move = dialog ? undefined : moveTarget(selected.surface);
  const handleSelect = (instance: RuntimeUiInstance) => {
    void model.focus(instance);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    void model.close(selected);
  };
  return (
    <div
      ref={rootRef}
      className={cn("flex min-h-0 flex-col overflow-hidden", className)}
      role={dialog ? "dialog" : "region"}
      aria-modal={dialog || undefined}
      aria-label={`Runtime application ${instanceLabel(selected)}`}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      data-runtime-ui-surface={selected.surface}
      data-testid={testId}
    >
      {chrome !== "hidden" && (
        <div
          className={cn(
            "flex items-center gap-2 border-b border-border px-3",
            chrome === "compact" ? "min-h-8 py-1" : "min-h-10 py-2",
          )}
        >
          <RuntimeUiSwitcher instances={instances} selected={selected} onSelect={handleSelect} />
          {chrome === "compact" ? (
            <p className="min-w-0 flex-1 truncate text-xs font-medium">{instanceLabel(selected)}</p>
          ) : (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{instanceLabel(selected)}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {selected.owner.extensionId}
              </p>
            </div>
          )}
          {pending && (
            <span className="text-xs text-muted-foreground" role="status">
              {pending.operation === "close"
                ? "Closing…"
                : pending.operation === "focus"
                  ? "Focusing…"
                  : "Updating…"}
            </span>
          )}
          {move && (
            <Button
              type="button"
              size={chrome === "compact" ? "icon-xs" : "icon-sm"}
              variant="ghost"
              aria-label={move.label}
              title={move.label}
              disabled={pending !== undefined}
              data-testid="runtime-ui-move"
              onClick={() => void model.focus(selected, move.surface)}
            >
              {move.surface === "bottom-panel" ? <PanelBottom /> : <MessageSquare />}
            </Button>
          )}
          <Button
            type="button"
            size={chrome === "compact" ? "xs" : "sm"}
            variant="ghost"
            aria-label={`Close ${instanceLabel(selected)}`}
            disabled={pending?.operation === "close"}
            onClick={() => void model.close(selected)}
          >
            Close
          </Button>
        </div>
      )}
      <RuntimeUiFrameChromeContext value={chromeReporter}>
        <RuntimeUiSessionSelection instance={selected}>
          <RuntimeUiImageSelection instance={selected}>
            <RuntimeUiDocumentCompanion instance={selected}>
              {selected.surface !== "inline-card" &&
              (isPackagedApplicationInstance(selected) || selected.content.kind === "file") ? (
                // Bounded applications and native editors own their scrolling.
                // A natural-height ScrollArea would collapse their height.
                <div className={cn("flex min-h-0 flex-1 flex-col", contentClassName)}>
                  <RuntimeUiRenderer instance={selected} layout="fill" />
                </div>
              ) : (
                <ScrollArea className={cn("min-h-0 flex-1", contentClassName)}>
                  <div className="p-4">
                    <RuntimeUiRenderer instance={selected} />
                  </div>
                </ScrollArea>
              )}
            </RuntimeUiDocumentCompanion>
          </RuntimeUiImageSelection>
        </RuntimeUiSessionSelection>
      </RuntimeUiFrameChromeContext>
    </div>
  );
}

export function RuntimeUiInlineSurface() {
  const { bySurface } = useRuntimeUiModel();
  if (bySurface["inline-card"].length === 0) {
    return <RuntimeUiEmptyState surface="inline-card" />;
  }
  return (
    <RuntimeUiInstanceFrame
      instances={bySurface["inline-card"]}
      className="mx-auto mb-48 w-full max-w-3xl shrink-0 rounded-xl border border-border bg-card shadow-sm in-data-[welcome=false]:mb-0"
      contentClassName="max-h-[28rem]"
      testId="runtime-ui-inline"
    />
  );
}

export function RuntimeUiPanelSurface() {
  const { bySurface } = useRuntimeUiModel();
  const [expanded, setExpanded] = useState(false);
  if (bySurface.panel.length === 0) return <RuntimeUiEmptyState surface="panel" />;
  return (
    <aside
      className={cn(
        "flex h-full min-w-72 shrink-0 flex-col border-l border-border bg-card",
        expanded ? "w-[min(60rem,72vw)]" : "w-[min(24rem,38vw)]",
      )}
      aria-label="Runtime side panel"
      data-testid="runtime-ui-panel"
      data-expanded={expanded ? "true" : "false"}
    >
      <div className="flex justify-end border-b border-border px-2 py-1">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={expanded ? "Collapse runtime side panel" : "Expand runtime side panel"}
          data-testid="runtime-ui-panel-expand"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Collapse" : "Expand"}
        </Button>
      </div>
      <RuntimeUiInstanceFrame instances={bySurface.panel} className="min-h-0 flex-1" />
    </aside>
  );
}

export function RuntimeUiWorkspaceTabs({ children }: { readonly children: ReactNode }) {
  const model = useRuntimeUiModel();
  const tabs = model.bySurface.tab;
  const newest = tabs[0];
  const newestSignature = newest ? `${newest.instanceId}:${newest.focusedAt}` : null;
  const [selection, setSelection] = useState(() => ({
    mode: newest ? ("runtime" as const) : ("chat" as const),
    observedFocus: newestSignature,
  }));
  const focusChanged = selection.observedFocus !== newestSignature;
  // Remote-originated focus never steals the desktop tab selection (M2); it is
  // acknowledged so a later desktop focus still registers as a change.
  const followFocus = newest === undefined || newest.focusedBy !== "remote";
  if (focusChanged) {
    setSelection({
      mode: followFocus ? (newest ? "runtime" : "chat") : selection.mode,
      observedFocus: newestSignature,
    });
  }
  const selectedMode = focusChanged
    ? followFocus
      ? newest
        ? "runtime"
        : "chat"
      : selection.mode
    : selection.mode;
  if (tabs.length === 0) return children;
  const selected = selectedMode === "runtime" ? newest : undefined;
  return (
    <div className="flex size-full min-h-0 flex-col" data-testid="runtime-ui-workspace-tabs">
      <div
        className="flex min-h-10 items-end gap-1 overflow-x-auto border-b border-border bg-background px-2 pt-1"
        role="tablist"
        aria-label="Workspace tabs"
      >
        <Button
          type="button"
          variant="ghost"
          role="tab"
          aria-selected={selectedMode === "chat"}
          className={cn(
            "h-9 rounded-b-none border-b-2 px-3",
            selectedMode === "chat" ? "border-primary" : "border-transparent",
          )}
          onClick={() =>
            setSelection({
              mode: "chat",
              observedFocus: newestSignature,
            })
          }
        >
          Chat
        </Button>
        {tabs.map((instance) => (
          <Button
            key={instance.instanceId}
            type="button"
            variant="ghost"
            role="tab"
            aria-selected={selected?.instanceId === instance.instanceId}
            className={cn(
              "h-9 max-w-56 rounded-b-none border-b-2 px-3",
              selected?.instanceId === instance.instanceId
                ? "border-primary"
                : "border-transparent",
            )}
            onClick={() => {
              setSelection({
                mode: "runtime",
                observedFocus: newestSignature,
              });
              void model.focus(instance);
            }}
          >
            <span className="truncate">{instanceLabel(instance)}</span>
          </Button>
        ))}
      </div>
      <div className={cn("min-h-0 flex-1", selectedMode === "chat" ? "block" : "hidden")}>
        {children}
      </div>
      {selected && (
        <RuntimeUiInstanceFrame
          instances={[selected]}
          className="min-h-0 flex-1 bg-card"
          contentClassName="h-full"
        />
      )}
    </div>
  );
}

function RuntimeUiFullscreenSurface() {
  const { bySurface } = useRuntimeUiModel();
  const isMobile = useIsMobile();
  const instances = useMemo(() => bySurface.fullscreen, [bySurface.fullscreen]);
  if (instances.length === 0) return <RuntimeUiEmptyState surface="fullscreen" />;
  return (
    <div
      className={cn(
        "fixed inset-0 z-70 flex bg-background/80 backdrop-blur-sm",
        isMobile ? "p-0" : "p-4",
      )}
      // Mobile browser/PWA chrome (notch, status bar, home indicator, the
      // collapsing address bar) can overlap this fixed overlay and hide
      // RuntimeUiInstanceFrame's header — including its Close button —
      // underneath it, leaving only OS-level gestures to get back. Padding
      // by env(safe-area-inset-*) (requires viewport-fit=cover, see
      // index.html) keeps everything inside the actually-tappable area.
      style={
        isMobile
          ? {
              paddingTop: "env(safe-area-inset-top)",
              paddingRight: "env(safe-area-inset-right)",
              paddingBottom: "env(safe-area-inset-bottom)",
              paddingLeft: "env(safe-area-inset-left)",
            }
          : undefined
      }
      data-testid="runtime-ui-fullscreen"
    >
      <RuntimeUiInstanceFrame
        instances={instances}
        className={cn(
          "m-auto size-full max-w-6xl bg-card",
          // 100dvh, not 100vh: on mobile Safari, 100vh is measured against the
          // largest viewport (address bar collapsed) and doesn't shrink when
          // the address bar is showing, clipping content under it.
          isMobile
            ? "max-h-dvh rounded-none border-0 shadow-none"
            : "max-h-[calc(100dvh-2rem)] rounded-xl border border-border shadow-2xl",
        )}
        contentClassName="h-full"
        dialog
      />
    </div>
  );
}
