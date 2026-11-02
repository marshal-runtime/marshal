import { getAppModeBadgeText } from "@common/app-mode-presentation";
import type { AppMode } from "@common/marshal-constants";

const BADGE_STYLES: Record<AppMode, string> = {
  dev: "border-warning-primary bg-secondary text-foreground",
  beta: "border-ring bg-accent text-foreground",
  release: "",
};

export function AppModeBadge({ mode }: { mode: AppMode }) {
  const text = getAppModeBadgeText(mode);
  if (!text) return null;

  return (
    <span
      aria-label={`${text} mode`}
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 align-middle text-[9px] leading-none font-bold tracking-wide uppercase ${BADGE_STYLES[mode]}`}
    >
      {text}
    </span>
  );
}
