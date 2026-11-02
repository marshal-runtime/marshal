import { APP_NAME } from "@common/marshal-constants";
import { useState } from "react";

import { ChevronDown, ChevronsUpDown, LogOut } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRelayAvailable } from "@/features/integrations/useRelayAvailability";
import { InteractiveElementMonitor_SignOut } from "@/services/telemetry/schema";
import { useIdentity } from "@/shared/hooks/useIdentity";

import { SignOutConfirmDialog } from "./presentation/SignOutConfirmDialog";

interface PersonContextMenuProps {
  /** Session-level connection indicator (SDK / gateway WS state). When
   *  false, overrides the identity's own status color with "danger" so the
   *  user sees a clear "disconnected" signal even though they're signed in. */
  connected?: boolean | null;
  onSignOut?: () => void;
  onOpenIntegrations?: () => void;
  compact?: boolean;
  /** Trigger presentation. "bar" is the full-width identity card (footer).
   *  "wordmark" is the Codex-style product wordmark that anchors the top of
   *  the sidebar; the account details live inside the opened menu. */
  variant?: "bar" | "wordmark";
}

const AVATAR_SIZE = { 7: "size-7", 8: "size-8" } as const;

const STATUS_COLOR_CLASS = {
  success: "bg-[var(--color-success)]",
  warning: "bg-[var(--color-warning-primary)]",
  danger: "bg-[var(--color-danger)]",
  muted: "bg-muted-foreground",
} as const;

function UserAvatar({ url, size }: { url: string | null; size: keyof typeof AVATAR_SIZE }) {
  return (
    <div className={`${AVATAR_SIZE[size]} overflow-hidden rounded-full border border-transparent`}>
      {url ? (
        <img src={url} alt="" className="size-full object-cover" data-testid="user-avatar" />
      ) : (
        <span className="flex size-full items-center justify-center text-sm">👤</span>
      )}
    </div>
  );
}

export function PersonContextMenu({
  connected,
  onSignOut,
  onOpenIntegrations,
  compact,
  variant = "bar",
}: PersonContextMenuProps) {
  const [confirmSignOutOpen, setConfirmSignOutOpen] = useState(false);
  const identity = useIdentity();
  const hasRelay = useRelayAvailable();
  const showIntegrationsList = hasRelay && identity.integrations.length > 0;

  // Session-level disconnection overrides the identity's own status color.
  // Everything else is backend-agnostic — PersonContextMenu renders whatever
  // the composer gave it.
  const effectiveStatusColor = connected === false ? "danger" : identity.statusColor;
  const statusDotColor = STATUS_COLOR_CLASS[effectiveStatusColor];
  const statusText =
    connected === false
      ? "Disconnected"
      : connected === null
        ? "Connecting..."
        : identity.statusText;

  // Wordmark anchors the top of the sidebar, so its menu drops downward; the
  // compact rail avatar opens to the side; the footer bar opens upward.
  const contentSide = variant === "wordmark" ? "bottom" : compact ? "right" : "top";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {variant === "wordmark" ? (
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-xl px-2 py-1.5 text-left hover:bg-(--bg-hover) focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label="User menu"
            >
              <span className="truncate text-sm font-semibold text-brand-action">{APP_NAME}</span>
              <ChevronDown size={16} className="shrink-0 text-muted-foreground" />
              <span
                data-testid="status-dot"
                className={`ml-auto size-2 shrink-0 rounded-full ${statusDotColor}`}
              />
            </button>
          ) : compact ? (
            <button
              type="button"
              className="relative flex size-9 items-center justify-center rounded-xl hover:bg-(--bg-hover) focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label="User menu"
            >
              <UserAvatar url={identity.avatarUrl} size={7} />
              <span
                data-testid="status-dot"
                className={`absolute right-1.5 bottom-1.5 size-2 rounded-full border border-background ${statusDotColor}`}
              />
            </button>
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-xl border border-border bg-background px-2.5 py-2 text-left hover:border-border/80 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label="User menu"
            >
              <div className="shrink-0">
                <UserAvatar url={identity.avatarUrl} size={8} />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs text-foreground">{identity.displayName}</span>
                <div className="flex items-center gap-1">
                  <span
                    data-testid="status-dot"
                    className={`size-2 shrink-0 rounded-full ${statusDotColor}`}
                  />
                  <span className="text-[10px] text-muted-foreground">{statusText}</span>
                </div>
              </div>
              <ChevronsUpDown size={16} className="shrink-0 text-muted-foreground" />
            </button>
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side={contentSide}
          align="start"
          sideOffset={6}
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56 gap-0 rounded-card p-2 shadow-[0_3px_12px_rgba(0,0,0,0.18)]"
        >
          <div className="flex flex-col gap-1 rounded-xl bg-muted px-3 py-2.5">
            <div className="truncate text-sm font-semibold text-foreground">
              {identity.displayName}
            </div>
            {identity.subtitle ? (
              <div className="truncate text-xs text-muted-foreground">{identity.subtitle}</div>
            ) : null}
          </div>

          {/* 6px spacer matching Figma's invisible divider — prevents hover from touching header */}
          <div className="h-1.5 shrink-0" />

          {showIntegrationsList ? (
            <>
              <DropdownMenuSeparator />

              <DropdownMenuLabel className="px-3 py-1.5 text-xs text-muted-foreground">
                Integrations
              </DropdownMenuLabel>

              {identity.integrations.map((integration) => (
                <DropdownMenuItem
                  key={integration.id}
                  className="flex cursor-pointer items-center justify-between rounded-xl px-3 py-1.5 text-sm"
                  onSelect={() => onOpenIntegrations?.()}
                >
                  <span className="text-foreground">{integration.name}</span>
                  <span className={integration.connected ? "text-success" : "text-warning-primary"}>
                    {integration.connected ? "Connected" : "Disconnected"}
                  </span>
                </DropdownMenuItem>
              ))}
            </>
          ) : null}

          <DropdownMenuSeparator />

          <InteractiveElementMonitor_SignOut callback={() => setConfirmSignOutOpen(true)}>
            {(cb) => (
              <DropdownMenuItem
                className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-foreground"
                onSelect={cb}
              >
                <LogOut size={20} className="shrink-0" />
                Sign out
              </DropdownMenuItem>
            )}
          </InteractiveElementMonitor_SignOut>
        </DropdownMenuContent>
      </DropdownMenu>

      <SignOutConfirmDialog
        open={confirmSignOutOpen}
        onOpenChange={setConfirmSignOutOpen}
        onConfirm={() => onSignOut?.()}
        title={identity.signOut.title}
        description={identity.signOut.description}
        confirmLabel={identity.signOut.confirmLabel}
      />
    </>
  );
}
