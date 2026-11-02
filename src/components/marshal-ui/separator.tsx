"use client";

import { Separator as SeparatorPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/marshal-class-names";

const SEPARATOR_CLASSES =
  "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch";

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(SEPARATOR_CLASSES, className)}
      {...props}
    />
  );
}

export { Separator };
