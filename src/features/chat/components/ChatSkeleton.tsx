import { Skeleton } from "@/components/marshal-ui/skeleton";

const BUBBLE_SHAPES = [
  "h-16 w-3/4 self-start",
  "h-12 w-2/3 self-end",
  "h-20 w-3/4 self-start",
] as const;

export function ChatSkeleton() {
  return (
    <div
      data-testid="chat-skeleton"
      role="status"
      aria-label="Loading conversation"
      className="flex flex-1 flex-col gap-4 overflow-hidden p-6"
    >
      {BUBBLE_SHAPES.map((className) => (
        <Skeleton key={className} data-testid="chat-skeleton-bubble" className={className} />
      ))}
    </div>
  );
}
