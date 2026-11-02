import { cn } from "@/lib/marshal-class-names";

const SKELETON_CLASSES = "animate-pulse rounded-md bg-muted";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn(SKELETON_CLASSES, className)} {...props} />;
}

export { Skeleton };
