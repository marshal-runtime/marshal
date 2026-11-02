export type AppNoticeSeverity = "blocking" | "danger" | "active" | "action" | "info";

export type AppNoticeSource = "force-update" | "auth" | "encryption-reset" | "mcp" | "update";

export type AppNoticeIcon =
  | "auth"
  | "cloud-off"
  | "cloud-sync"
  | "download"
  | "error"
  | "info"
  | "shield"
  | "spinner"
  | "success"
  | "update";

export type AppNoticeActionTone = "primary" | "secondary" | "destructive" | "link";

export type AppNoticeActionTelemetry =
  | "check-for-updates"
  | "download-update"
  | "restart-update"
  | "sign-in";

export type AppNoticeAction = {
  id: string;
  label: string;
  ariaLabel?: string;
  tone?: AppNoticeActionTone;
  telemetry?: AppNoticeActionTelemetry;
  disabled?: boolean;
  onAction: () => void | Promise<void>;
};

export type AppNoticeDismiss = {
  label?: string;
  onDismiss: () => void;
};

export type AppNotice = {
  id: string;
  source: AppNoticeSource;
  severity: AppNoticeSeverity;
  icon: AppNoticeIcon;
  title: string;
  body: string;
  details?: string;
  actions?: readonly AppNoticeAction[];
  dismiss?: AppNoticeDismiss;
  progress?: {
    label: string;
    value: number;
  };
};

export const APP_NOTICE_PRIORITY_TABLE: Readonly<
  Record<AppNoticeSeverity, readonly AppNoticeSource[]>
> = {
  blocking: ["force-update", "auth"],
  danger: ["encryption-reset", "mcp", "update"],
  active: ["force-update", "update"],
  action: ["mcp", "update"],
  info: ["update"],
};

const SEVERITY_ORDER: readonly AppNoticeSeverity[] = [
  "blocking",
  "danger",
  "active",
  "action",
  "info",
];

export type AppNoticeSnapshot = {
  notices: readonly AppNotice[];
  primary: AppNotice | null;
  additionalCount: number;
};

export function getAppNoticeSnapshot(
  notices: readonly (AppNotice | null | undefined)[],
  options: { forceUpdateInProgress?: boolean } = {},
): AppNoticeSnapshot {
  const active = notices.filter((notice): notice is AppNotice => {
    if (!notice) return false;
    return !(options.forceUpdateInProgress && notice.source === "update");
  });

  const ordered = active
    .map((notice, sourceIndex) => ({ notice, sourceIndex }))
    .sort((left, right) => {
      const severityDelta =
        SEVERITY_ORDER.indexOf(left.notice.severity) -
        SEVERITY_ORDER.indexOf(right.notice.severity);
      if (severityDelta !== 0) return severityDelta;

      const sourceOrder = APP_NOTICE_PRIORITY_TABLE[left.notice.severity];
      const leftSourceRank = sourceOrder.indexOf(left.notice.source);
      const rightSourceRank = sourceOrder.indexOf(right.notice.source);
      const sourceDelta =
        (leftSourceRank === -1 ? Number.MAX_SAFE_INTEGER : leftSourceRank) -
        (rightSourceRank === -1 ? Number.MAX_SAFE_INTEGER : rightSourceRank);
      if (sourceDelta !== 0) return sourceDelta;

      return left.sourceIndex - right.sourceIndex;
    })
    .map(({ notice }) => notice);

  return {
    notices: ordered,
    primary: ordered[0] ?? null,
    additionalCount: Math.max(0, ordered.length - 1),
  };
}
