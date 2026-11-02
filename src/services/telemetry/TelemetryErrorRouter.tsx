import type { MidgardError } from "@common/telemetry/types";
import { useEffect, useEffectEvent } from "react";

import { routeError, setOutOfSessionErrorLogger } from "./error-routing";
import { logErrorEventOutsideAppSession } from "./opensource";
import { useTelemetryInstance } from "./TelemetryInstanceContext";

/**
 * Always mounted by TelemetryInstanceProvider. Owns the single
 * window.telemetryAPI.onLogError subscription and registers the out-of-session
 * error logger. Before SessionScope mounts (pre-login), errors route here and
 * emit via logErrorEventOutsideAppSession — no sessionCorrelationId, and
 * userId/tenantId best-effort from the telemetry context (empty for fresh
 * users). Once SessionScope mounts, TelemetryErrorBridge registers an
 * in-session logger that routeError prefers.
 */
export function TelemetryErrorRouter(): null {
  const telemetry = useTelemetryInstance();

  const handleOutOfSession = useEffectEvent((error: MidgardError) => {
    logErrorEventOutsideAppSession(
      { midgardError: error },
      telemetry.telemetryCallbacks,
      telemetry.telemetryContextProps,
    );
  });

  useEffect(() => {
    setOutOfSessionErrorLogger(handleOutOfSession);
    // telemetryAPI is undefined in non-Electron environments; no-op there.
    const unsub = window.telemetryAPI?.onLogError(routeError);
    return () => {
      setOutOfSessionErrorLogger(null);
      unsub?.();
    };
  }, []); // safe: handleOutOfSession is a stable Effect Event

  return null;
}
