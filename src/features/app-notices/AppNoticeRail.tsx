import { useSyncExternalStore, useState } from "react";

import {
  AlertCircle,
  ArrowDownToLine,
  CircleCheck,
  CloudOff,
  CloudUpload,
  Info,
  Loader2,
  LogOut,
  ShieldAlert,
  X,
} from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/marshal-ui/marshal-popover";
import { Progress } from "@/components/marshal-ui/progress";
import { cn } from "@/lib/marshal-class-names";
import {
  InteractiveElementMonitor_CheckForUpdates,
  InteractiveElementMonitor_Download,
  InteractiveElementMonitor_Restart,
  InteractiveElementMonitor_SignIn,
  NonInteractiveElementMonitor_Banner,
  TelemetryPath_Update,
} from "@/services/telemetry/schema";

import type { AppNotice, AppNoticeAction, AppNoticeIcon, AppNoticeSeverity } from "./appNotice";
import { getAppNoticeSnapshot } from "./appNotice";
import { buildAuthNotice } from "./authNotice";
import { useEncryptionResetNotice } from "./encryptionNotice";
import { useMcpNotices } from "./mcpNotice";

const NARROW_RAIL_QUERY = "(max-width: 639px)";

const SEVERITY_CLASSES: Readonly<
  Record<AppNoticeSeverity, { rail: string; accent: string; icon: string }>
> = {
  blocking: {
    rail: "border-(--color-danger-border) bg-(--color-danger-bg)",
    accent: "bg-(--color-danger)",
    icon: "text-(--color-danger)",
  },
  danger: {
    rail: "border-status-warning-border bg-status-warning-bg",
    accent: "bg-(--color-warning)",
    icon: "text-(--color-warning-text)",
  },
  active: {
    rail: "border-brand-stroke bg-brand-subtle",
    accent: "bg-brand-action",
    icon: "text-brand-action",
  },
  action: {
    rail: "border-status-warning-border bg-status-warning-bg",
    accent: "bg-(--color-warning)",
    icon: "text-(--color-warning-text)",
  },
  info: {
    rail: "border-border bg-background",
    accent: "bg-muted-foreground",
    icon: "text-muted-foreground",
  },
};

type AppNoticeRailProps = {
  authError: string | null;
  runtimeId: string;
  onSignOut: () => void;
};

function subscribeToNarrowRail(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const media = window.matchMedia(NARROW_RAIL_QUERY);
  media.addEventListener?.("change", onChange);
  return () => media.removeEventListener?.("change", onChange);
}

function getNarrowRailSnapshot() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(NARROW_RAIL_QUERY).matches;
}

function useNarrowRail() {
  return useSyncExternalStore(subscribeToNarrowRail, getNarrowRailSnapshot, () => false);
}

function NoticeIcon({ icon, className }: { icon: AppNoticeIcon; className?: string }) {
  const props = {
    className: cn("size-5 shrink-0", className),
    "aria-hidden": true as const,
    "data-testid": "app-notice-icon",
  };
  switch (icon) {
    case "auth":
      return <LogOut {...props} />;
    case "cloud-off":
      return <CloudOff {...props} />;
    case "cloud-sync":
      return (
        <CloudUpload
          {...props}
          className={cn(props.className, "animate-pulse motion-reduce:animate-none")}
        />
      );
    case "download":
      return <ArrowDownToLine {...props} />;
    case "error":
      return <AlertCircle {...props} />;
    case "info":
      return <Info {...props} />;
    case "shield":
      return <ShieldAlert {...props} />;
    case "spinner":
      return (
        <Loader2
          {...props}
          className={cn(props.className, "animate-spin motion-reduce:animate-none")}
        />
      );
    case "success":
      return <CircleCheck {...props} />;
    case "update":
      return (
        <span
          className={cn("inline-block size-5 shrink-0 bg-current", className)}
          aria-hidden="true"
          data-testid="app-notice-icon"
          style={{
            maskImage: "url('./marshal-icon-outline.svg')",
            maskRepeat: "no-repeat",
            maskSize: "contain",
          }}
        />
      );
  }
  return null;
}

function actionVariant(action: AppNoticeAction) {
  switch (action.tone) {
    case "destructive":
      return "destructive" as const;
    case "link":
      return "link" as const;
    case "secondary":
      return "outline" as const;
    case "primary":
    default:
      return "brand" as const;
  }
}

function AppNoticeActionButton({
  action,
  compact = false,
}: {
  action: AppNoticeAction;
  compact?: boolean;
}) {
  const renderButton = (onClick: () => void) => (
    <Button
      key={action.id}
      size={compact ? "xs" : "sm"}
      variant={actionVariant(action)}
      aria-label={action.ariaLabel}
      disabled={action.disabled}
      onClick={onClick}
    >
      {action.label}
    </Button>
  );

  const monitored = (() => {
    switch (action.telemetry) {
      case "check-for-updates":
        return (
          <InteractiveElementMonitor_CheckForUpdates callback={action.onAction}>
            {(callback) => renderButton(callback)}
          </InteractiveElementMonitor_CheckForUpdates>
        );
      case "download-update":
        return (
          <InteractiveElementMonitor_Download callback={action.onAction}>
            {(callback) => renderButton(callback)}
          </InteractiveElementMonitor_Download>
        );
      case "restart-update":
        return (
          <InteractiveElementMonitor_Restart callback={action.onAction}>
            {(callback) => renderButton(callback)}
          </InteractiveElementMonitor_Restart>
        );
      case "sign-in":
        return (
          <InteractiveElementMonitor_SignIn callback={action.onAction}>
            {(callback) => renderButton(callback)}
          </InteractiveElementMonitor_SignIn>
        );
      default:
        return renderButton(() => void action.onAction());
    }
  })();

  return action.telemetry?.includes("update") || action.telemetry === "check-for-updates" ? (
    <TelemetryPath_Update>{monitored}</TelemetryPath_Update>
  ) : (
    monitored
  );
}

function NoticeProgress({ notice, compact = false }: { notice: AppNotice; compact?: boolean }) {
  if (!notice.progress) return null;
  return (
    <Progress
      value={notice.progress.value}
      aria-label={notice.progress.label}
      className={cn(
        "h-1.5 *:data-[slot=progress-indicator]:bg-brand-action",
        compact ? "w-full" : "w-[120px]",
      )}
    />
  );
}

function NoticePanelItem({ notice }: { notice: AppNotice }) {
  const severity = SEVERITY_CLASSES[notice.severity];
  return (
    <article
      className="relative grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-2 rounded-md border border-border bg-background p-3"
      data-notice-id={notice.id}
      data-testid={`app-notice-item-${notice.id}`}
    >
      <span
        className={cn("absolute inset-y-2 left-0 w-0.5 rounded-full", severity.accent)}
        aria-hidden="true"
      />
      <NoticeIcon icon={notice.icon} className={cn("mt-0.5 size-4", severity.icon)} />
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-foreground">{notice.title}</h3>
        <p className="mt-0.5 text-xs/relaxed text-muted-foreground">{notice.body}</p>
        {notice.details && (
          <p className="mt-1 text-xs/relaxed text-muted-foreground">{notice.details}</p>
        )}
      </div>
      {(notice.progress || notice.actions?.length || notice.dismiss) && (
        <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <NoticeProgress notice={notice} compact />
          {notice.actions?.map((action) => (
            <AppNoticeActionButton key={action.id} action={action} compact />
          ))}
          {notice.dismiss && (
            <Button
              size="xs"
              variant="ghost"
              aria-label={notice.dismiss.label ?? `Dismiss ${notice.title}`}
              onClick={notice.dismiss.onDismiss}
            >
              Dismiss
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

type AppNoticeRailViewProps = {
  notices: readonly (AppNotice | null | undefined)[];
  forceUpdateInProgress?: boolean;
};

export function AppNoticeRailView({
  notices,
  forceUpdateInProgress = false,
}: AppNoticeRailViewProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const isNarrow = useNarrowRail();
  const snapshot = getAppNoticeSnapshot(notices, { forceUpdateInProgress });
  const primary = snapshot.primary;

  if (!primary) return null;

  const severity = SEVERITY_CLASSES[primary.severity];
  const showPanelTrigger = snapshot.additionalCount > 0 || isNarrow || !!primary.details;
  const triggerLabel =
    snapshot.additionalCount > 0 ? `${snapshot.additionalCount} more` : "Details";

  const rail = (
    <div
      className={cn(
        "relative flex min-h-[50px] shrink-0 flex-nowrap items-center gap-2.5 overflow-hidden border-b px-3 py-1.5 text-sm",
        severity.rail,
      )}
      data-app-notice-rail
      data-primary-notice={primary.id}
      data-testid="app-notice-rail"
    >
      <span
        className={cn("absolute inset-y-1.5 left-0 w-0.5 rounded-full", severity.accent)}
        data-app-notice-severity
        aria-hidden="true"
      />
      <NoticeIcon icon={primary.icon} className={severity.icon} />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <strong className="truncate text-xs font-semibold text-foreground">{primary.title}</strong>
        {!isNarrow && (
          <span className="truncate text-xs text-muted-foreground">{primary.body}</span>
        )}
      </div>

      {!isNarrow && (
        <div className="flex shrink-0 items-center gap-1.5">
          <NoticeProgress notice={primary} />
          {primary.actions?.map((action) => (
            <AppNoticeActionButton key={action.id} action={action} />
          ))}
        </div>
      )}

      {showPanelTrigger && (
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              aria-label={
                snapshot.additionalCount > 0
                  ? `${snapshot.additionalCount} more app ${snapshot.additionalCount === 1 ? "notice" : "notices"}`
                  : "Show notice details and actions"
              }
            >
              {triggerLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="bottom"
            role="dialog"
            aria-label="App notices"
            data-app-notice-panel
            className="max-h-[min(70vh,520px)] w-[min(440px,calc(100vw-1rem))] gap-2 overflow-y-auto p-3 motion-reduce:animate-none"
          >
            <div className="flex items-center justify-between gap-3 px-0.5 pb-0.5">
              <h2 className="text-sm font-semibold text-foreground">App status</h2>
              <span className="text-xs text-muted-foreground">
                {snapshot.notices.length} {snapshot.notices.length === 1 ? "notice" : "notices"}
              </span>
            </div>
            <div className="grid gap-2">
              {snapshot.notices.map((notice) => (
                <NoticePanelItem key={notice.id} notice={notice} />
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {primary.dismiss && (
        <Button
          size="icon-sm"
          variant="ghost"
          className="shrink-0"
          aria-label={primary.dismiss.label ?? `Dismiss ${primary.title}`}
          onClick={primary.dismiss.onDismiss}
        >
          <X className="size-3.5" />
        </Button>
      )}

      <span
        className="sr-only"
        role={primary.severity === "blocking" ? "alert" : "status"}
        aria-live={primary.severity === "blocking" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {primary.title}. {primary.body}
      </span>
    </div>
  );

  return primary.source === "update" || primary.source === "force-update" ? (
    <TelemetryPath_Update>
      <NonInteractiveElementMonitor_Banner>{rail}</NonInteractiveElementMonitor_Banner>
    </TelemetryPath_Update>
  ) : (
    rail
  );
}

export function AppNoticeRail({ authError, runtimeId, onSignOut }: AppNoticeRailProps) {
  const encryptionNotice = useEncryptionResetNotice();
  const mcpNotices = useMcpNotices();
  const authNotice = authError ? buildAuthNotice({ error: authError, runtimeId, onSignOut }) : null;

  return (
    <AppNoticeRailView notices={[authNotice, encryptionNotice, ...mcpNotices]} />
  );
}
