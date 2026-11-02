import { createLogger } from "@common/marshal-logger";
import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App.tsx";
import { hydrationStore } from "./features/chat/session-state/hydration-store";
import { PopoutApp } from "./PopoutApp.tsx";
import { queryClient } from "./services/query/query-client";
import { startRendererResponsivenessProbe } from "./services/renderer-responsiveness";
import { wireQueryInvalidations } from "./shared/hooks/wireQueryInvalidations";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { applyTheme, type ThemeMode } from "./app-theme";
// Activate built-in 1P slot contributions before the first render.
import "./extensions/registered";

import "./index.css";

const log = createLogger("RendererMain");

// Expose OS to CSS so platform-specific styles (e.g. scrollbars) can be scoped.
// Apple platforms use native overlay scrollbars; custom ::-webkit-scrollbar rules
// would force Chromium into "classic" (always-visible) mode, so we skip them.
const isApple = window.platform === "darwin";
document.documentElement.setAttribute("data-platform", isApple ? "apple" : "other");

// Apply the cached theme synchronously before render. `applyTheme` writes the
// user's chosen mode to `localStorage["theme-mode"]`, so any window (main or
// chat popout) inherits the same theme as soon as it boots — no async
// `settingsAPI.get()` round-trip and no flash of unstyled chrome.
//
// Pre-v0.22.73 stored the resolved "light"/"dark" instead of "system", so
// existing users may boot with a stale value on the first launch after updating.
// App.tsx re-applies theme from marshal-settings.json (source of truth) on mount,
// which self-heals the cache — no explicit migration needed.
try {
  const raw = localStorage.getItem("theme-mode");
  const cached: ThemeMode = raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
  applyTheme(cached);
} catch {
  /* localStorage unavailable — fall back to default styling */
}

window.addEventListener("error", (e) => log.error("Uncaught error:", e.message, e.error));
window.addEventListener("unhandledrejection", (e) => log.error("Unhandled rejection:", e.reason));

const cleanupQueryInvalidations = wireQueryInvalidations(queryClient);
hydrationStore.initialize();
const stopRendererResponsivenessProbe = startRendererResponsivenessProbe();
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cleanupQueryInvalidations();
    stopRendererResponsivenessProbe();
  });
}

// chat popout windows load with `?popout=<sessionId>` in the URL.
// Render the lightweight PopoutApp instead of the full App in those windows.
const popoutSessionId = new URLSearchParams(window.location.search).get("popout");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {popoutSessionId ? <PopoutApp sessionId={popoutSessionId} /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
