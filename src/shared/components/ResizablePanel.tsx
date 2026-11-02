import { ChevronRight, Maximize2, Minimize2, PanelRightClose } from "@/components/icons";
import type { ReactNode } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";
import { cn } from "@/lib/marshal-class-names";
import type { ResizablePanelController } from "@/shared/hooks/useResizablePanel";

export function ResizablePanelHandle({
  controller,
  className,
  label,
  testId,
}: {
  controller: ResizablePanelController;
  className?: string;
  label: string;
  testId?: string;
}) {
  if (controller.mode !== "normal") return null;
  const horizontal = controller.axis === "horizontal";

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-valuemin={Math.round(controller.minSize)}
      aria-valuemax={Math.round(controller.maxSize)}
      aria-valuenow={Math.round(controller.normalSize)}
      className={cn(
        "group z-20 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        horizontal
          ? "absolute inset-y-0 left-0 w-2 cursor-col-resize"
          : "absolute inset-x-0 top-0 h-2 cursor-row-resize",
        className,
      )}
      onMouseDown={controller.handleMouseDown}
      onKeyDown={controller.handleKeyDown}
      onDoubleClick={controller.expand}
      data-testid={testId}
    >
      <span
        className={cn(
          "absolute bg-transparent transition-colors group-hover:bg-primary group-focus-visible:bg-primary",
          horizontal ? "inset-y-0 left-1/2 w-px" : "inset-x-0 top-1/2 h-px",
        )}
      />
    </div>
  );
}

interface ResizablePanelControlTestIds {
  show?: string;
  expand?: string;
  restore?: string;
  collapse?: string;
}

export function ResizablePanelControls({
  controller,
  showLabel,
  expandLabel,
  restoreLabel,
  collapseLabel,
  showIcon = <ChevronRight className="size-3.5" />,
  expandIcon = <Maximize2 className="size-3.5" />,
  restoreIcon = <Minimize2 className="size-3.5" />,
  collapseIcon = <PanelRightClose className="size-3.5" />,
  canCollapse = true,
  className,
  testIds,
}: {
  controller: ResizablePanelController;
  showLabel: string;
  expandLabel: string;
  restoreLabel: string;
  collapseLabel: string;
  showIcon?: ReactNode;
  expandIcon?: ReactNode;
  restoreIcon?: ReactNode;
  collapseIcon?: ReactNode;
  canCollapse?: boolean;
  className?: string;
  testIds?: ResizablePanelControlTestIds;
}) {
  if (controller.isCollapsed) {
    return (
      <div className={cn("flex items-center gap-0.5", className)}>
        <PanelControlButton
          label={showLabel}
          onClick={controller.restore}
          testId={testIds?.show}
          icon={showIcon}
        />
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      {controller.isExpanded ? (
        <PanelControlButton
          label={restoreLabel}
          onClick={controller.restore}
          testId={testIds?.restore}
          icon={restoreIcon}
        />
      ) : (
        controller.canExpand && (
          <PanelControlButton
            label={expandLabel}
            onClick={controller.expand}
            testId={testIds?.expand}
            icon={expandIcon}
          />
        )
      )}
      {canCollapse && (
        <PanelControlButton
          label={collapseLabel}
          onClick={controller.collapse}
          testId={testIds?.collapse}
          icon={collapseIcon}
        />
      )}
    </div>
  );
}

function PanelControlButton({
  label,
  onClick,
  icon,
  testId,
}: {
  label: string;
  onClick: () => void;
  icon: ReactNode;
  testId?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onClick}
          aria-label={label}
          data-testid={testId}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" hideArrow>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
