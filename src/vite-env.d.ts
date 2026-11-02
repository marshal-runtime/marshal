/// <reference types="vite/client" />

import type { RuntimeAcceptanceAPI } from "../common/runtime-acceptance";

declare global {
  const __APP_VERSION__: string;
  const __IS_RELEASE_BUILD__: boolean;
  /** Diagnostics, experiments and other developer surfaces (MARSHAL_DEV_FEATURES=true at build). */
  const __MARSHAL_DEV_FEATURES__: boolean;
  interface Window {
    platform?: string;
    runtimeAcceptanceAPI?: RuntimeAcceptanceAPI;
  }
}

export {};
