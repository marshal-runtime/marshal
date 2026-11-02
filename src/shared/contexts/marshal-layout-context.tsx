// Ownership: shared layout context.
import { createContext } from "react";

export interface LayoutContextValue {
  sidebarCollapsed: boolean;
  chatCollapsed: boolean;
  toggleSidebar: () => void;
  toggleChat: () => void;
}

export const LayoutContext = createContext<LayoutContextValue | null>(null);
