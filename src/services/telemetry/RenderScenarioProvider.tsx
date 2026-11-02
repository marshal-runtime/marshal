import * as React from "react";

import {
  generateGuid,
  RenderMonitorContext,
  getEmptyRenderScenarioAggregates,
  type RenderScenario,
  type RenderScenarioAction,
  useRenderMonitorInitializer,
  useTelemetry,
} from "./opensource";

type RenderScenarioProviderProps = {
  view: string;
  children: React.ReactNode;
};

export const RenderScenarioProvider = ({
  children,
  view,
}: RenderScenarioProviderProps): React.JSX.Element => {
  const telemetry = useTelemetry();

  // Derived state: track which view we last generated a scenario for.
  const [trackedView, setTrackedView] = React.useState(view);
  const [scenario, setScenario] = React.useState<{
    correlationId: string;
    action: RenderScenarioAction;
  }>(() => ({ correlationId: generateGuid(), action: "Open" }));

  if (trackedView !== view) {
    setTrackedView(view);
    setScenario({ correlationId: generateGuid(), action: "Navigate" });
  }

  const { correlationId, action } = scenario;

  const getRenderScenario = React.useCallback(
    (): RenderScenario => ({
      renderScenarioCorrelationId: correlationId,
      preRenderStartTime: telemetry.telemetryContextProps.getPreRenderStartTime(),
      renderStartTime: Date.now(),
      action,
      targetView: view,
      ...getEmptyRenderScenarioAggregates(),
    }),
    [correlationId, action, view, telemetry],
  );

  const renderMonitor = useRenderMonitorInitializer(telemetry, {
    getRenderScenario,
  });

  return (
    <RenderMonitorContext.Provider value={renderMonitor}>{children}</RenderMonitorContext.Provider>
  );
};
