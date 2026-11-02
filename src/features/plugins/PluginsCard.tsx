import type { CatalogItem } from "@common/extensions-catalog/marshal-extension-catalog";
import type { KeyboardEvent } from "react";

import { FileEdit, KeyRound, Plug, Settings, Sparkles, Trash2 } from "@/components/icons";
import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Switch } from "@/components/marshal-ui/marshal-switch";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/marshal-class-names";

// Whole card is clickable; inner Buttons / Switch handle their own clicks via
// e.stopPropagation. Using `<Card role="button">` rather than the prior
// `<button>` is what makes that legal HTML — `<button>` cannot contain
// `<button>` and React would emit a hydration warning on every render.
//
// Manual keyboard activation (Enter / Space) is required when the click target
// isn't a real `<button>`. See https://eastondev.com/blog/en/posts/dev/20260330-shadcn-radix-accessibility/
function activateOnEnterOrSpace(onActivate: (() => void) | undefined) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onActivate) return;
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate();
    }
  };
}

const CARD_BASE =
  "w-full min-w-0 min-h-[208px] cursor-pointer justify-between gap-0 rounded-[var(--radius-card)]! border border-border/70 bg-card p-5 text-left ring-0 transition-[transform,box-shadow,border-color,background-color] duration-200 hover:border-border-loud/40 hover:bg-card hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70";

export type InstallState = "available" | "installed" | "built-in" | "installing" | "needs-config";

interface CatalogCardProps {
  item: CatalogItem;
  installState: InstallState;
  onInstall: (item: CatalogItem) => void;
  onUse?: (item: CatalogItem) => void;
  onClick?: () => void;
  onOpenFile?: (item: CatalogItem) => void;
  onUninstall?: (item: CatalogItem) => void;
}

export function CatalogCard({
  item,
  installState,
  onInstall,
  onUse,
  onClick,
  onOpenFile,
  onUninstall,
}: CatalogCardProps) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={activateOnEnterOrSpace(onClick)}
      className={cn(CARD_BASE, installState === "installing" && "opacity-60")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <PluginTypeIcon itemType={item.type} />
          <div className="min-w-0 flex-1">
            <span className="line-clamp-2 block text-sm/6 font-semibold">{item.displayName}</span>
            {item.type === "skills" ? (
              <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                /{item.name}
              </p>
            ) : (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.author}</p>
            )}
          </div>
        </div>
        {installState === "built-in" && (
          <Badge
            variant="outline"
            className="rounded-md border-brand-badge-border bg-brand-badge-bg text-[10px] text-brand-badge-text"
          >
            BUILT-IN
          </Badge>
        )}
      </div>

      <p className="mt-3 line-clamp-3 min-h-12 text-xs/relaxed text-foreground-secondary">
        {item.description}
      </p>

      <div className="mt-5 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
        <InstallBadge
          state={installState}
          onInstall={(e) => {
            e.stopPropagation();
            onInstall(item);
          }}
          onUse={
            onUse
              ? (e) => {
                  e.stopPropagation();
                  onUse(item);
                }
              : undefined
          }
        />
        {(installState === "installed" || installState === "needs-config") &&
          (onOpenFile || onUninstall) && (
            <CardActionIcons
              onOpenFile={onOpenFile ? () => onOpenFile(item) : undefined}
              onUninstall={onUninstall ? () => onUninstall(item) : undefined}
            />
          )}
      </div>
    </Card>
  );
}

/** Card for user-created/custom items (skills or MCP servers). */
export function CustomItemCard({
  name,
  itemType = "skills",
  slug,
  description,
  enabled,
  bundleDirs,
  onClick,
  onToggle,
  onUse,
  actionLabel,
  actionDisabled,
  onAction,
  onOpenFile,
  onOpenEnvFile,
  onUninstall,
}: {
  name: string;
  itemType?: CatalogItem["type"];
  slug?: string;
  description?: string;
  enabled?: boolean;
  bundleDirs?: string[];
  onClick?: () => void;
  onToggle?: (enabled: boolean) => void;
  onUse?: () => void;
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
  onOpenFile?: () => void;
  onOpenEnvFile?: () => void;
  onUninstall?: () => void;
}) {
  const isDisabled = enabled === false && onToggle != null;

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={activateOnEnterOrSpace(onClick)}
      className={CARD_BASE}
    >
      <div className="flex w-full flex-col">
        <div className="flex items-start justify-between gap-3">
          <div
            className={`flex min-w-0 flex-1 items-start gap-3 ${isDisabled ? "text-muted-foreground" : ""}`}
          >
            <PluginTypeIcon itemType={itemType} />
            <div className="min-w-0 flex-1">
              <span className="line-clamp-2 block text-sm/6 font-semibold">{name}</span>
              {slug && (
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  /{slug}
                </p>
              )}
            </div>
          </div>
          {onToggle != null && (
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <span className="text-[11px] text-muted-foreground">
                {enabled ? "Enabled" : "Disabled"}
              </span>
              <Switch
                checked={enabled ?? false}
                aria-label={`${name}: ${enabled ? "disable" : "enable"}`}
                onCheckedChange={(checked) => {
                  onToggle(checked);
                }}
                onClick={(e) => e.stopPropagation()}
                className="shrink-0"
              />
            </div>
          )}
        </div>
        {description && (
          <p
            className={`mt-3 line-clamp-3 min-h-12 text-xs/relaxed text-foreground-secondary ${isDisabled ? "text-muted-foreground" : ""}`}
          >
            {description}
          </p>
        )}
        {bundleDirs && bundleDirs.length > 0 && (
          <div
            className={`mt-1.5 flex flex-wrap gap-1 ${isDisabled ? "text-muted-foreground" : ""}`}
          >
            {bundleDirs.map((dir) => (
              <span
                key={dir}
                className="rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {dir}
              </span>
            ))}
          </div>
        )}
      </div>

      <div
        className={`mt-5 flex items-center justify-between gap-2 border-t border-border/60 pt-3 ${isDisabled ? "text-muted-foreground" : ""}`}
      >
        {actionLabel && onAction ? (
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg bg-background/70"
            disabled={isDisabled || actionDisabled}
            onClick={(e) => {
              e.stopPropagation();
              onAction();
            }}
          >
            {actionLabel}
          </Button>
        ) : onUse ? (
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg bg-background/70"
            disabled={isDisabled}
            onClick={(e) => {
              e.stopPropagation();
              onUse();
            }}
          >
            Use
          </Button>
        ) : (
          <span />
        )}
        {(onOpenFile || onOpenEnvFile || onUninstall) && (
          <CardActionIcons
            onOpenFile={onOpenFile}
            onOpenEnvFile={onOpenEnvFile}
            onUninstall={onUninstall}
          />
        )}
      </div>
    </Card>
  );
}

function CardActionIcons({
  onOpenFile,
  onOpenEnvFile,
  onUninstall,
}: {
  onOpenFile?: () => void;
  onOpenEnvFile?: () => void;
  onUninstall?: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {onOpenFile && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-lg border border-border/60 bg-background/70 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFile();
          }}
          aria-label="Open in Editor"
          title="Open in Editor"
        >
          <FileEdit className="size-3.5" />
        </Button>
      )}
      {onOpenEnvFile && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-lg border border-border/60 bg-background/70 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onOpenEnvFile();
          }}
          aria-label="Edit env file"
          title="Edit env file"
        >
          <KeyRound className="size-3.5" />
        </Button>
      )}
      {onUninstall && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-lg border border-border/60 bg-background/70 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onUninstall();
          }}
          aria-label="Uninstall"
          title="Uninstall"
        >
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

function InstallBadge({
  state,
  onInstall,
  onUse,
}: {
  state: InstallState;
  onInstall: (e: React.MouseEvent) => void;
  onUse?: (e: React.MouseEvent) => void;
}) {
  switch (state) {
    case "built-in":
    case "installed":
      return (
        <Button
          variant="outline"
          size="sm"
          className="rounded-lg bg-background/70"
          onClick={onUse ?? onInstall}
        >
          Use
        </Button>
      );
    case "installing":
      return <span className="px-2 py-1 text-xs text-muted-foreground">Installing...</span>;
    case "needs-config":
      return (
        <Badge
          variant="outline"
          className="rounded-full border-(--status-warning-border) bg-(--status-warning-bg) text-(--status-warning-fg)"
        >
          <Settings />
          Needs config
        </Badge>
      );
    case "available":
      return (
        <Button variant="default" size="sm" className="rounded-lg" onClick={onInstall}>
          Install
        </Button>
      );
    default:
      state satisfies never;
      return null;
  }
}

function PluginTypeIcon({ itemType }: { itemType: CatalogItem["type"] }) {
  const Icon = itemType === "mcp-servers" ? Plug : Sparkles;
  return (
    <span
      aria-hidden="true"
      className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-brand-badge-bg text-brand-badge-text"
    >
      <Icon className="size-4" />
    </span>
  );
}
