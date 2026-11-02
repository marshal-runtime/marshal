// Ownership: shared layout hook.
import { useContext } from "react";

import { LayoutContext } from "./marshal-layout-context";

export function useLayout() {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error("useLayout must be used within a LayoutProvider");
  return ctx;
}
