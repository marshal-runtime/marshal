/**
 * SkeletonRow — Placeholder row used while the context picker is loading
 * its first results. Sized to match the real result rows
 * (PeopleResultRow / FileResultRow) so that the picker
 * mounts at its final height and does not visibly reflow when results
 * arrive. See ContextPickerMenu.tsx for usage.
 */

import { Skeleton } from "@/components/marshal-ui/skeleton";

function SkeletonTextBlock() {
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <Skeleton className="h-3 w-1/2 rounded-sm" />
      <Skeleton className="h-2.5 w-3/4 rounded-sm" />
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div
      data-testid="context-picker-skeleton-row"
      aria-hidden="true"
      className="flex items-center gap-2.5 rounded-md px-3 py-2"
    >
      <Skeleton className="size-7 shrink-0 rounded-full" />
      <SkeletonTextBlock />
    </div>
  );
}
