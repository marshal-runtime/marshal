import { createContext, use } from "react";

import type { RuntimeUiModel } from "./useRuntimeUi";
export const RuntimeUiContext = createContext<RuntimeUiModel | null>(null);
export function useOptionalRuntimeUiModel() {
  return use(RuntimeUiContext);
}
