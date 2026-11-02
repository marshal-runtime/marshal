import { ChevronLeft, X } from "@/components/icons";

import { Button } from "../marshal-ui/marshal-button";

interface SurfaceHeaderProps {
  title: string;
  onClose?: () => void;
  onBack?: () => void;
}

export function SurfaceHeader({ title, onClose, onBack }: SurfaceHeaderProps) {
  return (
    <header
      data-slot="surface-header"
      className="sticky top-0 z-10 flex h-[52px] shrink-0 items-center justify-between border-b border-border/70 bg-background/95 px-4 backdrop-blur-sm"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {onBack && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            aria-label="Back"
            className="-ml-1 text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </Button>
        )}
        <span
          aria-hidden="true"
          className="h-5 w-1 shrink-0 rounded-full bg-brand-action ring-1 ring-brand-action/20"
        />
        <h2 className="truncate text-sm font-semibold tracking-[0.01em] text-foreground">
          {title}
        </h2>
      </div>
      {onClose && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="-mr-1 text-muted-foreground hover:text-foreground"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="size-4" />
        </Button>
      )}
    </header>
  );
}
