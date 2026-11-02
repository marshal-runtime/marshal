import { Button } from "@/components/marshal-ui/marshal-button";
import { cn } from "@/lib/marshal-class-names";

import { useWindowState } from "../windowing/use-window-state";

import { NO_DRAG_STYLE } from "./drag-styles";

const windowButtonClass = cn("w-[38px] text-foreground-secondary", "[&>svg]:size-3.5");

export function HeaderWindowControls() {
  const { isMaximized: isWindowMaximized } = useWindowState();
  const windowControlsAPI = window.windowControlsAPI;
  const supportsWindowControls = window.platform === "win32" && !!windowControlsAPI;

  if (!supportsWindowControls || !windowControlsAPI) {
    return null;
  }

  return (
    <div
      className="ml-2 flex items-center border-l border-border pl-2"
      style={NO_DRAG_STYLE}
      role="group"
      aria-label="Window controls"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className={windowButtonClass}
        onClick={() => void windowControlsAPI.minimize()}
        title="Minimize window"
        aria-label="Minimize window"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M4 8.5h8" strokeLinecap="round" />
        </svg>
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className={windowButtonClass}
        onClick={() => void windowControlsAPI.toggleMaximize()}
        title={isWindowMaximized ? "Restore window" : "Maximize window"}
        aria-label={isWindowMaximized ? "Restore window" : "Maximize window"}
      >
        {isWindowMaximized ? (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M5 5.5h6v6H5z" />
            <path d="M7 3.5h4v4" />
            <path d="M5 5.5V4.8c0-.72.58-1.3 1.3-1.3H11" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="4.5" y="4.5" width="7" height="7" />
          </svg>
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(windowButtonClass, "hover:bg-(--color-danger) hover:text-primary-foreground")}
        onClick={() => void windowControlsAPI.close()}
        title="Close window"
        aria-label="Close window"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M5 5l6 6M11 5l-6 6" strokeLinecap="round" />
        </svg>
      </Button>
    </div>
  );
}
