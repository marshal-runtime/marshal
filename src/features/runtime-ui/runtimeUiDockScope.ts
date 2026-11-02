import { createContext } from "react";

/**
 * The runtime-UI scope key of the dock a view is rendered in. The document
 * companion steps aside inside the dock for its own session, whose documents
 * already sit in the side dock as tabs.
 */
export const RuntimeUiDockScopeContext = createContext<string | null>(null);
