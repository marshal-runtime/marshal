import type { RuntimeUiInstance } from "@common/runtime-ui";
import type { RuntimeUiDockRegion } from "@common/runtime-ui-layout";
import { createContext, use } from "react";

export interface SessionDockContextValue {
  /** Stable DOM hosts the chat and progress trees are portaled into. */
  readonly chatHost: HTMLElement;
  readonly progressHost: HTMLElement;
  readonly instances: ReadonlyMap<string, RuntimeUiInstance>;
  readonly progressOpen: boolean;
  /** The tab shown over the whole dock area, if any. */
  readonly maximizedPanelId: string | null;
  readonly closeView: (instanceId: string) => void;
  readonly moveView: (panelId: string, region: RuntimeUiDockRegion) => void;
  readonly toggleMaximize: (panelId: string) => void;
  readonly showProgress: () => void;
  readonly hideProgress: () => void;
}

export const SessionDockContext = createContext<SessionDockContextValue | null>(null);

export function useDock(): SessionDockContextValue {
  const value = use(SessionDockContext);
  if (!value) throw new Error("Dock panels render inside SessionDock.");
  return value;
}
