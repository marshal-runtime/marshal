import * as React from "react";

import type { Telemetry } from "./opensource";

/** Holds the Telemetry instance (callbacks + context props) built once by
 *  TelemetryInstanceProvider. SessionScope and TelemetryErrorRouter read it. */
// eslint-disable-next-line react/only-export-components -- context object + companion hook, no component; leaf module to avoid circular imports
export const TelemetryInstanceContext = React.createContext<Telemetry | null>(null);

export function useTelemetryInstance(): Telemetry {
  const telemetry = React.useContext(TelemetryInstanceContext);
  if (!telemetry) {
    throw new Error("useTelemetryInstance must be used within a TelemetryInstanceProvider");
  }
  return telemetry;
}
