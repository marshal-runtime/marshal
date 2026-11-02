import { FORGET_COMPLETELY_CARD_TITLE, PermissionAction } from "@common/marshal-constants";
import { createLogger } from "@common/marshal-logger";
import { useState } from "react";

import {
  Terminal,
  FileEdit,
  FileText,
  Puzzle,
  Globe,
  Settings,
  X,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Clock,
  Maximize2,
  Info,
  type MarshalIcon,
} from "@/components/icons";
import { Alert, AlertDescription } from "@/components/marshal-ui/alert";
import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/marshal-ui/marshal-collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { NoticeDismissButton } from "@/components/ui/dismissible-notice";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { SERVICE_TERMS_URL } from "@/features/auth/legal-links";
import { cn } from "@/lib/marshal-class-names";
import {
  TelemetryPath_PermissionCard,
  InteractiveElementMonitor_Accept,
  InteractiveElementMonitor_Deny,
  InteractiveElementMonitor_AlwaysAllow,
  InteractiveElementMonitor_AllowForSession,
} from "@/services/telemetry/schema";
import type { PermissionCardData, PermissionKind } from "@/types/electron";

interface PermissionCardProps {
  request: PermissionCardData;
  onRespond: (requestId: string, action: PermissionAction, overridePattern?: string) => void;
  onDismiss?: (requestId: string) => void;
  defaultDetailsExpanded?: boolean;
  surface?: "standalone" | "tray";
}

const KIND_ICONS: Record<PermissionKind, MarshalIcon> = {
  shell: Terminal,
  write: FileEdit,
  mcp: Puzzle,
  read: FileText,
  url: Globe,
  "custom-tool": Puzzle,
  memory: Puzzle,
  hook: Puzzle,
  settings: Settings,
};

const log = createLogger("PermissionCard");

const KIND_LABELS: Record<PermissionKind, string> = {
  shell: "Command",
  write: "File Edit",
  mcp: "MCP Tool",
  read: "File Read",
  url: "URL Access",
  "custom-tool": "Custom Tool",
  memory: "Memory",
  hook: "Hook",
  settings: "Permission Change",
};

const OUTPUT_PREVIEW_LIMIT = 120;

const CATEGORY_BADGE: Record<
  string,
  { label: string; variant: "secondary" | "destructive" | "outline"; className?: string }
> = {
  readonly: { label: "Read-only", variant: "secondary" },
  writes: {
    label: "Writes files",
    variant: "outline",
    className: "bg-status-warning-bg text-status-warning-fg border-status-warning-border",
  },
  network: { label: "Network", variant: "outline" },
  destructive: { label: "Destructive", variant: "destructive" },
};

const DETAIL_PREVIEW_LENGTH = 200;

const LABEL_TO_ACTION: Record<string, PermissionAction> = {
  Allow: "allow",
  "Allow for session": "allow-session",
  "Always allow": "always-allow",
  Deny: "deny",
  // Legacy consent-card wording retained for cards loaded from disk
  "Accept and continue": "allow",
  Cancel: "deny",
  // Legacy labels for cards loaded from disk before the migration
  "Auto-allow safe commands": "allow-type",
  "Always allow this": "allow-type",
  "Allow all tools": "allow-all",
};

// Display-only label overrides. The wire label in `request.buttons` is the
// canonical name (matched by LABEL_TO_ACTION and by mini-mode), but the
// chat-card UI surfaces a friendlier verb-led variant.
const DISPLAY_LABEL_OVERRIDES: Record<string, string> = {
  "Always allow": "Allow everywhere",
};

// Static tooltips for the four standard buttons. Owned by the renderer
// because these strings are pure UI copy and don't depend on request data.
// Anything not in this map falls through to `request.tooltips` (legacy /
// custom labels) and renders no tooltip if that's also empty.
const BUTTON_TOOLTIPS: Record<string, string> = {
  Allow: "Allow this action once",
  "Allow for session": "Allow this action until this session ends",
  "Always allow": "Always allow this action in all chats",
  Deny: "Deny this action once",
};

const SCOPE_LABELS: Partial<Record<PermissionAction, { label: string; description: string }>> = {
  "allow-session": {
    label: "This session",
    description: "Allow matching actions until this chat ends",
  },
  "always-allow": {
    label: "All chats",
    description: "Remember this access for matching actions",
  },
  "allow-type": {
    label: "Similar safe actions",
    description: "Remember the suggested safe-action pattern",
  },
  "allow-all": {
    label: "All tools",
    description: "Allow every tool covered by this request",
  },
};

function fallbackAccessLabel(kind: PermissionKind, title: string): string {
  if (kind === "shell") return "Command execution";
  if (kind === "read") return "Read access";
  if (kind === "write") return "Changes files";
  if (kind === "settings")
    return title === FORGET_COMPLETELY_CARD_TITLE ? "Erases memory permanently" : "Changes settings";
  if (kind === "memory") return "Saves information";
  if (kind === "url") return "Uses network access";
  if (kind === "mcp" || kind === "custom-tool") return "Uses a connected tool";
  if (kind === "hook") return "Runs a hook";
  return "Runs an action";
}

function WarningBanner({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <Alert
      data-testid={testId}
      className="border-status-warning-border bg-status-warning-bg px-3 py-2 text-xs text-status-warning-fg [&>svg]:top-2 [&>svg]:left-3 [&>svg]:text-status-warning-fg [&>svg~*]:pl-5"
    >
      <AlertTriangle size={14} />
      <AlertDescription className="text-xs">{children}</AlertDescription>
    </Alert>
  );
}

function PermissionDetail({ detail, title }: { detail: string; title: string }) {
  const isLong = detail.length > DETAIL_PREVIEW_LENGTH;
  const preview = isLong ? detail.slice(0, DETAIL_PREVIEW_LENGTH) + "…" : detail;

  if (!isLong) {
    return (
      <pre className="max-h-40 overflow-auto rounded-lg bg-accent p-3 font-mono text-xs wrap-break-word whitespace-pre-wrap">
        {detail}
      </pre>
    );
  }

  return (
    <>
      <pre className="max-h-40 overflow-hidden rounded-lg bg-accent p-3 font-mono text-xs wrap-break-word whitespace-pre-wrap">
        {preview}
      </pre>
      <Dialog>
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <Maximize2 size={12} />
            Expand details
          </Button>
        </DialogTrigger>
        <DialogContent
          className="flex max-h-[80vh] flex-col overflow-hidden sm:max-w-2xl"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <pre className="min-h-0 flex-1 overflow-auto rounded-lg bg-accent p-4 font-mono text-xs wrap-break-word whitespace-pre-wrap">
            {detail}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}

function withoutDuplicateSdkWarning(detail: string, sdkWarning?: string): string {
  if (!sdkWarning) return detail;
  const warningDetail = `Warning: ${sdkWarning}`;
  if (detail === warningDetail) return "";
  const suffix = `\n\n${warningDetail}`;
  return detail.endsWith(suffix) ? detail.slice(0, -suffix.length) : detail;
}

function openTerms(event: React.MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  void window.shellAPI?.openExternal(SERVICE_TERMS_URL);
}

interface PermissionActionOption {
  action: PermissionAction;
  label: string;
  displayLabel: string;
  tooltip?: React.ReactNode;
  overridePattern?: string;
}

function PermissionActionMonitor({
  action,
  onActivate,
  children,
}: {
  action: PermissionAction;
  onActivate: () => void;
  children: (activate: () => void) => React.ReactNode;
}) {
  if (action === "deny") {
    return (
      <InteractiveElementMonitor_Deny callback={onActivate}>
        {children}
      </InteractiveElementMonitor_Deny>
    );
  }
  if (action === "always-allow") {
    return (
      <InteractiveElementMonitor_AlwaysAllow callback={onActivate}>
        {children}
      </InteractiveElementMonitor_AlwaysAllow>
    );
  }
  if (action === "allow-session") {
    return (
      <InteractiveElementMonitor_AllowForSession callback={onActivate}>
        {children}
      </InteractiveElementMonitor_AllowForSession>
    );
  }
  return (
    <InteractiveElementMonitor_Accept callback={onActivate}>
      {children}
    </InteractiveElementMonitor_Accept>
  );
}

export function PermissionCard({
  request,
  onRespond,
  onDismiss,
  defaultDetailsExpanded = true,
  surface = "standalone",
}: PermissionCardProps) {
  const Icon = KIND_ICONS[request.kind];
  const kindLabel = KIND_LABELS[request.kind];
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(defaultDetailsExpanded);

  if (request.resolved) {
    const isAllowed = request.resolved === "allowed";
    const isDenied = request.resolved === "denied";
    const isFailed = request.resolved === "failed";
    const isTimedOut = request.resolved === "timed-out";
    const isRunning = isAllowed && request.output == null;
    const hasOutput = (isAllowed || isFailed) && !!request.output;
    const outputTruncated = hasOutput && request.output!.length > OUTPUT_PREVIEW_LIMIT;

    return (
      <div
        className={cn("rounded-xl border border-border bg-card p-3", isRunning && "animate-pulse")}
        data-kind={request.kind}
        data-testid="permission-card"
        data-resolved={request.resolved}
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{request.title}</span>
          {isRunning ? (
            <span className="shrink-0 text-xs text-muted-foreground">Running</span>
          ) : (
            <span
              className={cn(
                "flex shrink-0 items-center gap-1 text-xs",
                (isDenied || isTimedOut) && "text-destructive",
                isFailed && "text-warning-primary",
              )}
              data-testid="resolved-badge"
            >
              {isAllowed && "Allowed"}
              {isDenied && (
                <>
                  <X size={12} strokeWidth={2.5} /> Denied
                </>
              )}
              {isTimedOut && (
                <>
                  <Clock size={12} strokeWidth={2.5} /> Timed out
                </>
              )}
              {isFailed && (
                <>
                  <AlertTriangle size={12} strokeWidth={2.5} /> Failed
                </>
              )}
            </span>
          )}
          {(isFailed || isTimedOut) && onDismiss && (
            <NoticeDismissButton
              aria-label={isTimedOut ? "Dismiss timed out tool notice" : "Dismiss tool error"}
              onClick={() => onDismiss(request.id)}
            />
          )}
        </div>

        {request.detail && (
          <p className="mt-1 truncate text-xs text-muted-foreground">{request.detail}</p>
        )}

        {isRunning && (
          <div
            className="mt-2 h-0.5 animate-pulse rounded-sm bg-primary"
            data-testid="running-bar"
          />
        )}

        {hasOutput && (
          <Collapsible open={outputExpanded} onOpenChange={setOutputExpanded} className="mt-2">
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto gap-1 p-0 text-xs text-muted-foreground hover:text-foreground"
                data-testid="output-toggle"
              >
                <ChevronRight
                  size={12}
                  className={cn("transition-transform duration-200", outputExpanded && "rotate-90")}
                />
                Output
              </Button>
            </CollapsibleTrigger>
            {!outputExpanded && (
              <p
                className="mt-1 truncate text-xs text-muted-foreground"
                data-testid="output-preview"
              >
                {outputTruncated
                  ? `${request.output!.slice(0, OUTPUT_PREVIEW_LIMIT)}...`
                  : request.output}
              </p>
            )}
            <CollapsibleContent>
              <pre
                className="mt-1 max-h-40 overflow-auto rounded-sm bg-muted p-2 font-mono text-xs"
                data-testid="output-full"
              >
                {request.output}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    );
  }

  // Secondary "Allow broader pattern" is shown only when the LLM classifier
  // has surfaced a broader suggestion that differs from the heuristic primary.
  // Primary is always driven by request.approvalPattern (fed from primaryPattern
  // here) and never mutates after card creation — safety invariant.
  const isShellAction = request.kind === "shell";
  const primaryPattern = request.primaryPattern;
  const desktopDetail = withoutDuplicateSdkWarning(request.detail, request.sdkWarning);
  const broaderPattern =
    isShellAction &&
    primaryPattern !== undefined &&
    primaryPattern !== null &&
    request.suggestedPattern &&
    request.suggestedPattern !== primaryPattern
      ? request.suggestedPattern
      : null;
  const actionOptions: PermissionActionOption[] = request.buttons.flatMap((label) => {
    const action = LABEL_TO_ACTION[label];
    if (!action) {
      log.warn(`Unknown button label: "${label}"`);
      return [];
    }
    return [
      {
        action,
        label,
        displayLabel: DISPLAY_LABEL_OVERRIDES[label] ?? label,
        tooltip: BUTTON_TOOLTIPS[label] ?? request.tooltips?.[label],
      },
    ];
  });
  const allowOnce = actionOptions.find((option) => option.action === "allow");
  const deny = actionOptions.find((option) => option.action === "deny");
  const scopeOptions = actionOptions.filter(
    (option) => option.action !== "allow" && option.action !== "deny",
  );
  if (broaderPattern) {
    scopeOptions.push({
      action: "always-allow",
      label: "Allow broader pattern",
      displayLabel: "Similar actions in all chats",
      tooltip: (
        <>
          Always allow <span className="font-mono wrap-break-word">{broaderPattern}</span> in all
          chats
        </>
      ),
      overridePattern: broaderPattern,
    });
  }
  const categoryBadge =
    request.category && CATEGORY_BADGE[request.category]
      ? CATEGORY_BADGE[request.category]
      : {
          label: fallbackAccessLabel(request.kind, request.title),
          variant: "outline" as const,
        };

  return (
    <TelemetryPath_PermissionCard>
      <div
        className={cn(
          "animate-in p-3 fade-in",
          surface === "standalone" && "rounded-xl border border-border bg-card shadow-xs",
        )}
        data-kind={request.kind}
        data-testid="permission-card"
        data-surface={surface}
      >
        <div className="flex items-start gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
            <Icon size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Permission needed
              </span>
              <Badge
                variant={categoryBadge.variant}
                className={cn("h-5 px-1.5 text-[10px]", categoryBadge.className)}
              >
                {categoryBadge.label}
              </Badge>
            </div>
            <h3 className="text-sm font-medium text-foreground">{request.title}</h3>
            {request.message && (
              <p className="mt-1 text-sm/relaxed whitespace-pre-wrap text-muted-foreground">
                {request.message}
              </p>
            )}
          </div>
        </div>
        <div className="mt-2.5 space-y-2">
          {request.sdkWarning && (
            <WarningBanner testId="sdk-warning-alert">{request.sdkWarning}</WarningBanner>
          )}
          {request.sensitivePathWarning && (
            <WarningBanner testId="sensitive-path-warning">
              {request.sensitivePathWarning}
            </WarningBanner>
          )}
          {request.browserUseDisclosure && (
            <div className="flex items-start gap-1.5 text-xs/relaxed text-muted-foreground">
              <Info size={12} className="mt-0.5 shrink-0" />
              <span>
                Browser Control can interact with sites using your existing browser session.{" "}
                <a
                  href={SERVICE_TERMS_URL}
                  className="text-primary underline underline-offset-2"
                  onClick={openTerms}
                >
                  Learn about browser use
                </a>
                .
              </span>
            </div>
          )}
          {desktopDetail && (
            <Collapsible open={detailsExpanded} onOpenChange={setDetailsExpanded}>
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                  data-testid="permission-details-toggle"
                >
                  <ChevronRight
                    className={cn("size-3.5 transition-transform", detailsExpanded && "rotate-90")}
                    aria-hidden
                  />
                  Review technical details
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-1">
                <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                  {kindLabel}
                </div>
                <PermissionDetail detail={desktopDetail} title={request.title} />
              </CollapsibleContent>
            </Collapsible>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {allowOnce && (
              <PermissionActionMonitor
                action={allowOnce.action}
                onActivate={() => onRespond(request.id, allowOnce.action)}
              >
                {(activate) => {
                  const button = (
                    <Button
                      size="sm"
                      className="bg-brand-action text-brand-action-fg hover:bg-brand-action-hover"
                      onClick={activate}
                      data-testid="permission-allow-once"
                    >
                      {allowOnce.label === "Allow" ? "Allow once" : allowOnce.displayLabel}
                    </Button>
                  );
                  return allowOnce.tooltip ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{button}</TooltipTrigger>
                      <TooltipContent className="max-w-md">{allowOnce.tooltip}</TooltipContent>
                    </Tooltip>
                  ) : (
                    button
                  );
                }}
              </PermissionActionMonitor>
            )}
            {deny && (
              <PermissionActionMonitor
                action={deny.action}
                onActivate={() => onRespond(request.id, deny.action)}
              >
                {(activate) => {
                  const button = (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={activate}
                      data-testid="permission-not-now"
                    >
                      {deny.label === "Deny" ? "Not now" : deny.displayLabel}
                    </Button>
                  );
                  return deny.tooltip ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{button}</TooltipTrigger>
                      <TooltipContent className="max-w-md">{deny.tooltip}</TooltipContent>
                    </Tooltip>
                  ) : (
                    button
                  );
                }}
              </PermissionActionMonitor>
            )}
            {scopeOptions.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-muted-foreground hover:text-foreground"
                    data-testid="permission-scope-trigger"
                  >
                    Choose access scope
                    <ChevronDown className="size-3.5" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-64">
                  <DropdownMenuLabel>Broader access</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {scopeOptions.map((option) => {
                    const scope = SCOPE_LABELS[option.action];
                    const isBroader = option.overridePattern !== undefined;
                    const label = isBroader
                      ? option.displayLabel
                      : (scope?.label ?? option.displayLabel);
                    const description = isBroader
                      ? option.tooltip
                      : (option.tooltip ?? scope?.description);
                    return (
                      <PermissionActionMonitor
                        key={`${option.label}-${option.overridePattern ?? ""}`}
                        action={option.action}
                        onActivate={() =>
                          onRespond(request.id, option.action, option.overridePattern)
                        }
                      >
                        {(activate) => (
                          <DropdownMenuItem
                            className="items-start py-2"
                            onSelect={activate}
                            data-testid={
                              isBroader
                                ? "allow-broader-pattern"
                                : option.action === "always-allow"
                                  ? "allow-primary-pattern"
                                  : undefined
                            }
                          >
                            <span className="min-w-0">
                              <span className="block font-medium text-foreground">{label}</span>
                              {description && (
                                <span className="mt-0.5 block text-xs/relaxed text-muted-foreground">
                                  {description}
                                </span>
                              )}
                            </span>
                          </DropdownMenuItem>
                        )}
                      </PermissionActionMonitor>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>
    </TelemetryPath_PermissionCard>
  );
}
