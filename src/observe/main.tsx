import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";

const bootConfigSearch = location.search;
const bootViewport = new URLSearchParams(bootConfigSearch).get("viewport");
// The TRUE mobile presentation: the same client-form-factor switches the
// remote client sets (clientUiViewport, packagedUiHostContext.formFactor,
// viewport gates) — set BEFORE any component renders.
if (bootViewport === "mobile") {
  window.marshalRemote = true;
  document.documentElement.dataset.remote = "true";
}

/* eslint-disable import/first -- form factor must be pinned before the runtime-ui modules render */
import { applyTheme } from "../app-theme";
import { TooltipProvider } from "../components/marshal-ui/marshal-tooltip";
import { queryClient } from "../services/query/query-client";
import { ErrorBoundary } from "../shell/ErrorBoundary";
import { ObserveApp, parseObserveConfig } from "./ObserveApp";

import "../index.css";
/* eslint-enable import/first */

// Parsed ONCE: the config (and its scope object) must be referentially stable
// for the lifetime of the harness — see ObserveConfig.scope.
const config = parseObserveConfig(bootConfigSearch);

void window.settingsAPI
  ?.get()
  .then((result) => {
    if (result.settings) applyTheme(result.settings.theme ?? "system");
  })
  .catch(() => {
    /* Default theme is a valid capture surface. */
  });

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ObserveApp config={config} />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
