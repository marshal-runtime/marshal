import { createContext } from "react";

/**
 * OMR2-2: how much native frame chrome (title + extension-identity row) the
 * host renders around an application surface. "full" is the default for every
 * application; packaged apps that render their own header opt into "compact"
 * or "hidden" via the `hostChrome` param of `ui/initialize`.
 */
export type RuntimeUiFrameChrome = "full" | "compact" | "hidden";

export interface RuntimeUiFrameChromeReporter {
  readonly report: (instanceId: string, chrome: RuntimeUiFrameChrome) => void;
}

export const RuntimeUiFrameChromeContext = createContext<RuntimeUiFrameChromeReporter | null>(null);

/** Accepts only the two documented opt-in values; anything else keeps full chrome. */
export function parseHostChromeHint(value: unknown): "compact" | "hidden" | undefined {
  return value === "compact" || value === "hidden" ? value : undefined;
}
