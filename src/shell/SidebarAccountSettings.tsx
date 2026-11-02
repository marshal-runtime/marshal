import type { MouseEvent } from "react";

import { Settings, User } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { cn } from "@/lib/marshal-class-names";
import { useIdentity } from "@/shared/hooks/useIdentity";

interface SidebarAccountSettingsProps {
  compact?: boolean;
  isActive: boolean;
  isCurrent: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

function AccountAvatar({ url, displayName }: { url: string | null; displayName: string }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground">
      {url ? (
        <img src={url} alt="" className="size-full object-cover" data-testid="user-avatar" />
      ) : displayName.trim() ? (
        displayName.trim().charAt(0).toUpperCase()
      ) : (
        <User className="size-4" />
      )}
    </span>
  );
}

export function SidebarAccountSettings({
  compact = false,
  isActive,
  isCurrent,
  onClick,
}: SidebarAccountSettingsProps) {
  const identity = useIdentity();

  const button = (
    <Button
      variant="ghost"
      size={compact ? "icon-lg" : undefined}
      className={cn(
        "rounded-xl text-foreground transition-colors duration-150 hover:bg-(--bg-hover)",
        compact
          ? "relative"
          : "h-auto w-full justify-start gap-2 px-3 py-2 font-normal [&_svg]:text-foreground",
        isActive && "bg-active-subtle font-semibold",
      )}
      aria-label={compact ? "Settings" : `Open Settings for ${identity.displayName}`}
      aria-current={isCurrent ? "page" : undefined}
      onClick={onClick}
      data-testid="sidebar-account-settings"
    >
      <AccountAvatar url={identity.avatarUrl} displayName={identity.displayName} />
      {compact ? (
        <Settings className="absolute right-0.5 bottom-0.5 size-3 rounded-full bg-accent" />
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-left text-sm">{identity.displayName}</span>
          <Settings className="size-4 shrink-0 text-muted-foreground" />
        </>
      )}
    </Button>
  );

  if (!compact) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">Settings</TooltipContent>
    </Tooltip>
  );
}
