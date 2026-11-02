import { useEffect, useEffectEvent } from "react";

import { finalizeTelemetry } from "./finalization";

export function TelemetryFinalizerBridge(): null {
  const finalize = useEffectEvent(async (acknowledgeMain: boolean) => {
    await finalizeTelemetry();
    if (acknowledgeMain) {
      await window.telemetryAPI?.rendererFinalized();
    }
  });

  useEffect(() => {
    const handlePageHide = () => {
      void finalize(false);
    };
    window.addEventListener("pagehide", handlePageHide);
    const unsubscribe = window.telemetryAPI?.onFinalize(() => {
      void finalize(true);
    });
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      unsubscribe?.();
    };
  }, []);

  return null;
}
