import type { RuntimeUiInstance } from "@common/runtime-ui";

import { Maximize2 } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";

import { useExpandedView } from "./expandedView";

/** One tap opens the view full screen on this device; renders nothing without a provider. */
export function ExpandViewButton({
  instance,
  title,
  className,
}: {
  readonly instance: RuntimeUiInstance;
  readonly title: string;
  readonly className?: string;
}) {
  const control = useExpandedView();
  if (!control) return null;
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      className={className}
      aria-label={`Expand ${title}`}
      data-testid="runtime-ui-expand"
      onClick={() => control.expand(instance.instanceId)}
    >
      <Maximize2 className="size-3.5" />
    </Button>
  );
}

/** Stands in for a view while it is expanded, so only one live copy runs. */
export function ExpandedPlaceholder() {
  const control = useExpandedView();
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-24 w-full rounded-none text-xs font-normal text-muted-foreground"
      data-testid="runtime-ui-expanded-placeholder"
      onClick={control?.collapse}
    >
      Showing full screen · Tap to return
    </Button>
  );
}
