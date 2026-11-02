import { APP_NAME } from "@common/marshal-constants";
import type { ReactNode } from "react";

import { AppModeBadge } from "@/shell/branding/AppModeBadge";
import { DRAG_STYLE } from "@/shell/drag-styles";
import { useAppMode } from "@/shell/useMarshalAppMode";

interface Props {
  children: ReactNode;
  /** Stage label announced via aria-live when stage changes. */
  ariaLiveLabel: string;
  /** Card width — 380 for action cards, 420 for loading/code cards. Defaults to 420. */
  width?: "380" | "420";
  /** Vertical padding — 8 (=32px) for action cards, 10 (=40px) for loading cards. Defaults to 8. */
  paddingY?: "8" | "10";
  /**
   * hero — full-viewport layout without the card border/shadow/rounded container.
   * Use for screens that need to fill the window rather than float in a card.
   */
  variant?: "card" | "hero";
}

export function AuthCardShell({ children, ariaLiveLabel, width, paddingY, variant }: Props) {
  const appMode = useAppMode();
  const isHero = variant === "hero";
  const cardWidth = width === "380" ? "w-[380px]" : "w-[420px]";
  const cardPadding = paddingY === "10" ? "py-10" : "py-8";

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header
        className="flex h-12 shrink-0 items-center justify-center border-b border-border/80 bg-background/95 px-2.5 select-none"
        style={DRAG_STYLE}
      >
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold tracking-[-0.01em]">
          {APP_NAME}
          <AppModeBadge mode={appMode} />
        </span>
      </header>

      <div className={`flex flex-1 items-center justify-center ${isHero ? "p-8" : "p-5"}`}>
        <span role="status" aria-live="polite" className="sr-only">
          {ariaLiveLabel}
        </span>
        {isHero ? (
          children
        ) : (
          <div
            className={`flex flex-col items-center gap-6 rounded-card border border-border/80 bg-card px-12 shadow-card ${cardWidth} ${cardPadding}`}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
