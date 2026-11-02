/**
 * Telemetry service backed by the OpenTelemetry API with local event sinks.
 *
 * TelemetryInstanceProvider builds the telemetry instance once and stays mounted for
 * the whole app run (so pre-login errors route out-of-session via
 * TelemetryErrorRouter). SessionScope renders the SDK TelemetryContextProvider —
 * mounting it starts the session, unmounting ends it. TelemetryProvider composes
 * the two for callers that always want a session (popout, tests).
 */

import { TELEMETRY_HOST_APP } from "@common/marshal-constants";
import { registerAllErrors } from "@common/telemetry/errors/marshal-index";
import * as React from "react";

import { makeTelemetrySinkManagers } from "./makeTelemetrySinkManagers";
import {
  CopyTagsToFields,
  TelemetryContextProps,
  TelemetryContextProvider,
  emptyTelemetryContextProps,
  makeTelemetryCallbacks,
  startSession,
  type Telemetry,
  type TelemetryOptions,
  schema,
} from "./opensource";
import { TagGdprEvents } from "./TagGdprEvents";
import { TelemetryErrorBridge } from "./TelemetryErrorBridge";
import { TelemetryErrorRouter } from "./TelemetryErrorRouter";
import { TelemetryEventBridge } from "./TelemetryEventBridge";
import { TelemetryFinalizerBridge } from "./TelemetryFinalizerBridge";
import { TelemetryInstanceContext, useTelemetryInstance } from "./TelemetryInstanceContext";

// eslint-disable-next-line react/only-export-components -- re-export of the instance hook for callers that import from the telemetry barrel; the hook itself lives in the leaf TelemetryInstanceContext module
export { useTelemetryInstance } from "./TelemetryInstanceContext";

export type TelemetryInstanceProviderProps = {
  children: React.ReactNode;
  telemetryEnabled?: boolean;
};

export const TelemetryInstanceProvider: React.FC<TelemetryInstanceProviderProps> = ({
  children,
  telemetryEnabled,
}: TelemetryInstanceProviderProps) => {
  // Capture the opt-in preference at mount time. Changes only take effect on next
  // launch — adding telemetryEnabled to useMemo deps would recreate the session
  // context mid-session and fire a spurious second SessionStart event.
  const [telemetryEnabledAtMount] = React.useState(() => telemetryEnabled ?? true);

  const [sinkSetup] = React.useState(() => makeTelemetrySinkManagers(telemetryEnabledAtMount));

  const telemetry = React.useMemo((): Telemetry => {
    const telemetryContextProps: TelemetryContextProps = {
      ...emptyTelemetryContextProps,
      getAppVersion: () => __APP_VERSION__,
      getPreRenderStartTime: () => Date.now(),
      getAppName: () => TELEMETRY_HOST_APP,
      getUserId: () => "",
      // Required
      getComplianceEnvironment: () => "Df",
      getHostApp: () => TELEMETRY_HOST_APP,
      // getSessionCorrelationId is intentionally left to emptyTelemetryContextProps
      // (returns ""). The px-telemetry startSession() generates the GUID and
      // mutates this getter. We delegate hostApp to the same value at call time.
      getHostAppSessionCorrelationId: () => telemetryContextProps.getSessionCorrelationId(),
      getTenantId: () => "",
      // SoftRequired
      getAccountType: () => undefined,
      getHostAppPlatform: () => "Desktop",
      getHostAppRing: () => "",
      getHostAppVersion: () => __APP_VERSION__,
      // Per-event required/softRequired
      getSessionStartGesture: () => "hostApp",
      getFlights: () => "[]", // serialized JSON per PX schema
      getEcsConfigIds: () => "[]", // serialized JSON per PX schema
    };
    const options: TelemetryOptions = {
      sinkManagers: sinkSetup.sinkManagers,
      middlewares: [TagGdprEvents, CopyTagsToFields],
    };

    const telemetryCallbacks = makeTelemetryCallbacks(options, schema);
    registerAllErrors(telemetryCallbacks);
    return {
      telemetryCallbacks,
      telemetryContextProps,
    };
    // eslint-disable-next-line react-compiler/exhaustive-deps -- intentional: sinks are fixed at mount (see sinkSetup, seeded from telemetryEnabledAtMount)
  }, []);

  return (
    <TelemetryInstanceContext.Provider value={telemetry}>
      <TelemetryErrorRouter />
      <TelemetryFinalizerBridge />
      {children}
    </TelemetryInstanceContext.Provider>
  );
};

/**
 * Renders the SDK TelemetryContextProvider — mounting starts the session,
 * unmounting ends it (SessionEnd). Gate its mount to control session boundaries.
 */
export const SessionScope: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const telemetry = useTelemetryInstance();

  // useLayoutEffect fires before any useEffect in any component, closing the
  // 1-frame window between DOM commit and paint where child mount effects would
  // read getSessionCorrelationId() === "" (TelemetryContextProvider calls
  // startSession in useEffect, which React flushes after the browser paints).
  React.useLayoutEffect(() => {
    // startSession guards on getSessionCorrelationId() !== "" so calling it
    // again (e.g. from TelemetryContextProvider's own useEffect) is a no-op.
    startSession(telemetry.telemetryContextProps, telemetry.telemetryCallbacks, () => "");
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-compiler/exhaustive-deps -- intentional: one-shot; telemetry is stable from useMemo([])
  }, []);

  // TelemetryContextProvider's useEffect finds the session already started and
  // sets telemetry.isRootInstance = false. We restore it so SessionEnd fires on
  // unmount. No cleanup: React runs effect cleanups bottom-up (children before
  // parents), so a cleanup here would fire before RenderScenarioProvider's
  // endSession check and suppress SessionEnd entirely.
  React.useEffect(() => {
    // eslint-disable-next-line react-compiler/immutability -- intentional: TelemetryContextProvider (library) sets this to false; we correct it as the outer session owner
    telemetry.isRootInstance = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-compiler/exhaustive-deps -- intentional: one-shot; telemetry is stable from useMemo([])
  }, []);

  return (
    <TelemetryContextProvider telemetry={telemetry}>
      <TelemetryErrorBridge />
      <TelemetryEventBridge />
      {children}
    </TelemetryContextProvider>
  );
};

export type TelemetryProviderProps = TelemetryInstanceProviderProps;

/**
 * Convenience composition for callers that always want a session for the whole
 * subtree (popout windows, tests). App.tsx instead mounts TelemetryInstanceProvider
 * and SessionScope separately so the session can be gated on auth readiness.
 */
export const TelemetryProvider: React.FC<TelemetryProviderProps> = ({
  children,
  ...instanceProps
}) => (
  <TelemetryInstanceProvider {...instanceProps}>
    <SessionScope>{children}</SessionScope>
  </TelemetryInstanceProvider>
);
