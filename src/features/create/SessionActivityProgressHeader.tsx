import type { RuntimeUiInstance } from "@common/runtime-ui";
import type { ReactNode } from "react";

import { ChevronLeft, X } from "@/components/icons";
import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";

function evidenceTitle(evidence: RuntimeUiInstance): string | undefined {
  return evidence.content.kind === "file"
    ? evidence.content.path.split(/[\\/]/).pop()
    : evidence.owner.applicationId;
}

/**
 * The progress panel's title row: back and close for a selected evidence view,
 * the session count, todo progress, and the panel's own size controls. In a
 * dock tab the tab already names "Progress", so the title shows only for
 * evidence.
 */
export function SessionActivityProgressHeader({
  evidence,
  showProgressTitle,
  sessionCount,
  todoProgress,
  onBack,
  onClose,
  panelControls,
}: {
  readonly evidence: RuntimeUiInstance | undefined;
  readonly showProgressTitle: boolean;
  readonly sessionCount: number;
  readonly todoProgress: { readonly done: number; readonly total: number } | undefined;
  readonly onBack: () => void;
  /** Present when the selected evidence is a side-panel view the user may close. */
  readonly onClose: (() => void) | undefined;
  readonly panelControls: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      {evidence && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="-ml-2 shrink-0"
          aria-label="Back to progress"
          title="Back to progress"
          onClick={onBack}
        >
          <ChevronLeft className="size-4" />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        {(showProgressTitle || evidence) && (
          <h2 className="truncate text-sm font-semibold text-foreground">
            {evidence ? evidenceTitle(evidence) : "Progress"}
          </h2>
        )}
        <p className="mt-0.5 text-xs text-muted-foreground">
          {sessionCount} session{sessionCount === 1 ? "" : "s"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {todoProgress && (
          <Badge variant="outline">
            {todoProgress.done}/{todoProgress.total}
          </Badge>
        )}
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="Close" title="Close" onClick={onClose}>
            <X className="size-4" />
          </Button>
        )}
        {panelControls}
      </div>
    </div>
  );
}
