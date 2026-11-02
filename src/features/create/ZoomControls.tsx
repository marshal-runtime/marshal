import { Minus, Plus } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { ShortcutKbd } from "@/features/hotkeys";

import { ZOOM_EPSILON } from "./hooks/state/useZoom";

interface ZoomControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  minZoom: number;
  maxZoom: number;
  className?: string;
}

export function ZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
  minZoom,
  maxZoom,
  className,
}: ZoomControlsProps) {
  // Read inside the component (matches the Header.tsx / FileTree.tsx pattern)
  // so this lazy-loadable module doesn't read window.platform at import time
  // — that would break in any test path that imports it before the preload
  // bridge has set window.platform.
  const isMac = window.platform === "darwin";
  const modKey = isMac ? "Meta" : "Ctrl";

  const percent = Math.round(zoom * 100);
  const atMin = zoom <= minZoom + ZOOM_EPSILON;
  const atMax = zoom >= maxZoom - ZOOM_EPSILON;
  const atDefault = Math.abs(zoom - 1) < ZOOM_EPSILON;

  return (
    <div
      role="toolbar"
      aria-label="Zoom"
      data-testid="cocreate-zoom-controls"
      className={`flex items-center gap-0.5 rounded-md border border-border bg-card/95 p-0.5 shadow-sm backdrop-blur-sm ${className ?? ""}`}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onZoomOut}
            disabled={atMin}
            aria-label="Zoom out"
          >
            <Minus />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Zoom out <ShortcutKbd hotkey={`${modKey}+-`} />
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            onClick={onReset}
            disabled={atDefault}
            className="min-w-[42px] tabular-nums"
            aria-label={`Current zoom ${percent}%; reset to 100%`}
          >
            {percent}%
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Reset zoom <ShortcutKbd hotkey={`${modKey}+0`} />
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onZoomIn}
            disabled={atMax}
            aria-label="Zoom in"
          >
            <Plus />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Zoom in <ShortcutKbd hotkey={`${modKey}+=`} />
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
