import type { ReactNode } from "react";

interface HorizontalCarouselProps {
  children: ReactNode;
  className?: string;
}

/**
 * Responsive grid keeps plugin cards aligned without overflowing narrow panels.
 */
export function HorizontalCarousel({ children, className = "" }: HorizontalCarouselProps) {
  return (
    <div
      className={`grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] items-stretch gap-4 ${className}`}
    >
      {children}
    </div>
  );
}
