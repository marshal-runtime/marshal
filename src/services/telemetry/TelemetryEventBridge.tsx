import { useEffect, useEffectEvent } from "react";

import { useTelemetry } from "./opensource";

function str(val: unknown): string {
  return typeof val === "string" ? val : "";
}

/** Fields promoted to first-class Fetch event slots — excluded from misc to
 *  avoid duplication. See docs/architecture/12-marshal-telemetry.md for the schema. */
const PROMOTED = new Set([
  "duration",
  "source",
  "type",
  "scenario",
  "apiCallId",
  "providerCallId",
  "moduleName",
]);

/**
 * Subscribes to main-process telemetry events forwarded via
 * `window.telemetryAPI.onLogEvent` and emits them as Fetch events
 * through the renderer's already-configured pipeline.
 *
 * CommonEventFields (userId, sessionCorrelationId, appVersion, tenantId,
 * complianceEnvironment) are populated from the renderer's TelemetryContextProps
 * — the single source of truth. No duplicate pipeline needed in the main process.
 */
export function TelemetryEventBridge(): null {
  const telemetry = useTelemetry();

  const handleEvent = useEffectEvent(
    (event: { scenario: string; fields: Record<string, unknown> }) => {
      const { scenario, fields } = event;
      const misc: Record<string, number | string> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (PROMOTED.has(k)) continue;
        if (typeof v === "number" || typeof v === "string") misc[k] = v;
      }

      const ctx = telemetry.telemetryContextProps;
      telemetry.telemetryCallbacks.logFetchEvent({
        accountType: ctx.getAccountType(),
        appName: ctx.getAppName(),
        appVersion: ctx.getAppVersion(),
        clientType: ctx.getHostApp(),
        complianceEnvironment: ctx.getComplianceEnvironment(),
        eventUniqueIdentifier: "",
        hostApp: ctx.getHostApp(),
        hostAppApp: "",
        hostAppContext: "",
        hostAppPlatform: ctx.getHostAppPlatform(),
        hostAppRing: ctx.getHostAppRing(),
        hostAppSessionCorrelationId: ctx.getHostAppSessionCorrelationId(),
        hostAppSubSessionCorrelationId: "",
        hostAppVariant: "",
        hostAppVersion: ctx.getHostAppVersion(),
        sessionCorrelationId: ctx.getSessionCorrelationId(),
        tenantId: ctx.getTenantId(),
        userId: ctx.getUserId(),
        scenario,
        source: "HostApp",
        duration: typeof fields.duration === "number" ? fields.duration : 0,
        result: "success",
        component: "Backend",
        componentDataContractId: "",
        moduleName: str(fields.moduleName) || "LLM",
        path: "/Backend",
        pathDataContractIds: "",
        renderScenarioCorrelationId: "",
        requestCorrelationId: undefined,
        responseCorrelationId: undefined,
        errorCode: undefined,
        misc: JSON.stringify(misc),
      });
    },
  );

  useEffect(() => {
    // telemetryAPI is undefined in non-Electron environments; subscription is a no-op there.
    const unsub = window.telemetryAPI?.onLogEvent(handleEvent);
    return () => unsub?.();
  }, []); // safe: handleEvent is a stable Effect Event

  return null;
}
