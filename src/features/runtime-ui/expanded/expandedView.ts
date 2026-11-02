import { createContext, use } from "react";

export interface ExpandedViewControl {
  /** The view shown full screen on this device, if any. */
  readonly expandedId: string | null;
  readonly expand: (instanceId: string) => void;
  readonly collapse: () => void;
}

export const ExpandedViewContext = createContext<ExpandedViewControl | null>(null);

/**
 * Expanding is local to this device: it never moves the view or changes the
 * saved layout, so expanding on the phone leaves the desktop arrangement alone.
 */
export function useExpandedView(): ExpandedViewControl | null {
  return use(ExpandedViewContext);
}
