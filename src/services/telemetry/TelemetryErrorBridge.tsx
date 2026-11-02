import type { MidgardError } from "@common/telemetry/types";
import { useEffect, useEffectEvent } from "react";

import { setInSessionErrorLogger } from "./error-routing";
import { useGetLogErrorTelemetry } from "./opensource";

/**
 * In-session error bridge. Mounted inside SessionScope, it registers the
 * session-scoped error logger so routeError() (and therefore ErrorBoundary and
 * the main-process onLogError stream) emits Error events carrying
 * sessionCorrelationId while a session is active. The onLogError subscription
 * itself lives in TelemetryErrorRouter; this component only swaps in the
 * in-session logger for the lifetime of the session.
 */
export function TelemetryErrorBridge(): null {
  const logError = useGetLogErrorTelemetry();

  const handleError = useEffectEvent((error: MidgardError) => {
    logError(error);
  });

  useEffect(() => {
    setInSessionErrorLogger(handleError);
    return () => setInSessionErrorLogger(null);
  }, []); // safe: handleError is a stable Effect Event

  return null;
}
