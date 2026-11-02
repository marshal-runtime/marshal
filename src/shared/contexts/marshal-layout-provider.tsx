// Ownership: shared layout provider.
import { useState, useCallback, type ReactNode } from "react";

import { LayoutContext } from "./marshal-layout-context";

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);

  const toggleSidebar = useCallback(() => setSidebarCollapsed((v) => !v), []);
  const toggleChat = useCallback(() => setChatCollapsed((v) => !v), []);

  return (
    <LayoutContext value={{ sidebarCollapsed, chatCollapsed, toggleSidebar, toggleChat }}>
      {children}
    </LayoutContext>
  );
}
