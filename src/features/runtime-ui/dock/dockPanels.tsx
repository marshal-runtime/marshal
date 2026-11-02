import type { RuntimeUiDockRegion } from "@common/runtime-ui-layout";
import type {
  IDockviewHeaderActionsProps,
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
} from "dockview-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";

import {
  Ellipsis,
  ExternalLink,
  ListTodo,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelBottom,
  PanelRightOpen,
  X,
} from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { RuntimeUiViewBody } from "../RuntimeUiViewBody";
import { useDock } from "./dockContext";
import { CHAT_PANEL_ID, instanceIdOfPanel, PROGRESS_PANEL_ID, regionOfGroup } from "./dockLayout";

/** Re-parents a long-lived host element into this panel, so its React tree never remounts. */
function HostedPanel({ host, testId }: { readonly host: HTMLElement; readonly testId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    container.appendChild(host);
    return () => {
      if (host.parentElement === container) container.removeChild(host);
    };
  }, [host]);
  return (
    <div ref={containerRef} className="size-full min-h-0 overflow-hidden" data-testid={testId} />
  );
}

export function ChatDockPanel() {
  return <HostedPanel host={useDock().chatHost} testId="session-dock-chat" />;
}

export function ProgressDockPanel() {
  return <HostedPanel host={useDock().progressHost} testId="session-dock-progress" />;
}

export function ViewDockPanel({ api }: IDockviewPanelProps) {
  const dock = useDock();
  const instanceId = instanceIdOfPanel(api.id);
  const instance = instanceId ? dock.instances.get(instanceId) : undefined;
  if (!instance) return null;
  return (
    <div
      className="flex size-full min-h-0 flex-col bg-card"
      data-runtime-ui-surface={instance.surface}
      data-testid="session-dock-view"
    >
      <RuntimeUiViewBody instance={instance} fill />
    </div>
  );
}

/** Shown in an empty dock while a tab is dragged, so the drop target is obvious. */
export function DockWatermark() {
  return (
    <div className="flex size-full items-center justify-center border-2 border-dashed border-(--brand-stroke) bg-(--brand-subtle) text-xs font-medium text-(--brand-badge-text)">
      Drop a tab here
    </div>
  );
}

export function DockTab({ api }: IDockviewPanelHeaderProps) {
  const dock = useDock();
  const [title, setTitle] = useState(api.title ?? "");
  useEffect(() => {
    const subscription = api.onDidTitleChange((event) => setTitle(event.title));
    return () => subscription.dispose();
  }, [api]);
  const closable = api.id !== CHAT_PANEL_ID;
  const close = () => {
    if (api.id === PROGRESS_PANEL_ID) {
      dock.hideProgress();
      return;
    }
    const instanceId = instanceIdOfPanel(api.id);
    if (instanceId) dock.closeView(instanceId);
  };
  const handleAuxClick = (event: MouseEvent) => {
    if (event.button === 1 && closable) {
      event.preventDefault();
      close();
    }
  };
  return (
    <div
      className="group/tab flex h-full max-w-60 min-w-0 items-center gap-1 pr-1 pl-3 text-xs"
      onAuxClick={handleAuxClick}
      onDoubleClick={closable ? () => dock.toggleMaximize(api.id) : undefined}
      title={title}
      data-testid="session-dock-tab"
      data-panel-id={api.id}
    >
      {api.id === CHAT_PANEL_ID && <MessageSquare className="size-3.5 shrink-0" />}
      {api.id === PROGRESS_PANEL_ID && <ListTodo className="size-3.5 shrink-0" />}
      <span className="min-w-0 truncate">{title}</span>
      {closable ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="size-5 shrink-0 opacity-60 group-hover/tab:opacity-100"
          aria-label={`Close ${title}`}
          data-testid="session-dock-tab-close"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            close();
          }}
        >
          <X className="size-3" />
        </Button>
      ) : (
        <span className="w-1" />
      )}
    </div>
  );
}

const MOVE_TARGETS: readonly {
  readonly region: RuntimeUiDockRegion;
  readonly label: string;
  readonly icon: typeof MessageSquare;
}[] = [
  { region: "chat", label: "Move to chat tabs", icon: MessageSquare },
  { region: "side", label: "Move to side dock", icon: PanelRightOpen },
  { region: "bottom", label: "Move to bottom dock", icon: PanelBottom },
  { region: "floating", label: "Float", icon: ExternalLink },
];

export function DockGroupActions({ group, activePanel }: IDockviewHeaderActionsProps) {
  const dock = useDock();
  const region = regionOfGroup(group);
  const maximized = dock.maximizedPanelId !== null && activePanel?.id === dock.maximizedPanelId;
  const movable = activePanel !== undefined && activePanel.id !== CHAT_PANEL_ID;
  return (
    <div className="flex h-full items-center gap-0.5 px-1" data-testid="session-dock-actions">
      {region === "chat" && !dock.progressOpen && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Show progress"
          title="Show progress"
          data-testid="session-dock-show-progress"
          onClick={dock.showProgress}
        >
          <ListTodo className="size-3.5" />
        </Button>
      )}
      {movable && (region !== "floating" || maximized) && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={maximized ? "Restore layout" : "Maximize"}
          title={maximized ? "Restore layout" : "Maximize"}
          data-testid="session-dock-maximize"
          onClick={() => dock.toggleMaximize(activePanel.id)}
        >
          {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
      )}
      {movable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Tab actions"
              data-testid="session-dock-menu"
            >
              <Ellipsis className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {MOVE_TARGETS.filter((target) => target.region !== region).map((target) => (
              <DropdownMenuItem
                key={target.region}
                onSelect={() => dock.moveView(activePanel.id, target.region)}
              >
                <target.icon className="size-3.5" />
                {target.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                const instanceId = instanceIdOfPanel(activePanel.id);
                if (activePanel.id === PROGRESS_PANEL_ID) dock.hideProgress();
                else if (instanceId) dock.closeView(instanceId);
              }}
            >
              <X className="size-3.5" />
              Close tab
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
