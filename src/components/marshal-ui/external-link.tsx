import { type ComponentProps, type ReactNode } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import { cn } from "@/lib/marshal-class-names";

type ExternalLinkProps = {
  href: string;
  children: ReactNode;
} & Omit<ComponentProps<typeof Button>, "onClick" | "variant" | "asChild">;

/**
 * Inline link that opens `href` in the user's default browser via
 * shellAPI.openExternal. Rendered as a Button (not a raw <a>) so the link color
 * isn't clobbered by the unlayered global `a {}` reset in index.css, which beats
 * Tailwind utilities. Pass `className` to adjust size/color per surface.
 */
export function ExternalLink({ href, children, className, ...rest }: ExternalLinkProps) {
  return (
    <Button
      variant="link"
      className={cn("h-auto p-0 underline-offset-2", className)}
      onClick={() => void window.shellAPI?.openExternal(href)}
      {...rest}
    >
      {children}
    </Button>
  );
}
