"use client";

import { Label as LabelPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/marshal-class-names";

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  const labelClassName = cn(
    "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
    className,
  );

  return <LabelPrimitive.Root data-slot="label" className={labelClassName} {...props} />;
}

export { Label };
