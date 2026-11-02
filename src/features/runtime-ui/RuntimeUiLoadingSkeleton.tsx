import { cn } from "@/lib/marshal-class-names";

/** Card-shaped placeholder shown while a packaged or authored view loads. */
export function RuntimeUiLoadingSkeleton({
  label,
  className,
}: {
  readonly label: string;
  readonly className?: string;
}) {
  return (
    <div
      role="status"
      className={cn("flex flex-col gap-2.5 p-3", className)}
      data-testid="runtime-ui-loading"
    >
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="h-3 w-2/5 animate-pulse rounded-md bg-muted" />
      <span aria-hidden="true" className="h-3 w-5/6 animate-pulse rounded-md bg-muted" />
      <span aria-hidden="true" className="h-3 w-3/5 animate-pulse rounded-md bg-muted" />
    </div>
  );
}
