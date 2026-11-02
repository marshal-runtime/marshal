import { beforeEach, describe, expect, it, vi } from "vitest";

import { TelemetryProvider } from "@/services/telemetry";
import { TelemetryPath_App, TelemetryPath_Settings } from "@/services/telemetry/schema";
import { RenderScenarioProvider } from "@/services/telemetry/RenderScenarioProvider";
import { createCaptureSink, findUserAction, sinkSetup } from "@/services/telemetry/test-utils";
import { installMockAPIs, render, screen, waitFor, userEvent } from "@/test-utils";

import { DefaultModelPicker } from "./DefaultModelPicker";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

function renderPicker() {
  installMockAPIs();
  return render(
    <TelemetryProvider>
      <RenderScenarioProvider view="settings">
        {/* DefaultModelPicker wraps itself in TelemetryPath_Model */}
        <TelemetryPath_App>
          <TelemetryPath_Settings>
            <DefaultModelPicker enabled={true} />
          </TelemetryPath_Settings>
        </TelemetryPath_App>
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
}

describe("DefaultModelPicker telemetry", () => {
  beforeEach(() => {
    events.splice(0);
  });

  it("emits UserAction for Switch at /App/Settings/Model", async () => {
    const user = userEvent.setup();
    renderPicker();
    // Open the Select dropdown
    const trigger = await screen.findByTestId("default-model-select");
    await user.click(trigger);
    // Select the second model option
    await user.click(await screen.findByText("GPT-5.4 Mini"));
    await waitFor(() => {
      expect(findUserAction(events, "Switch", "/App/Settings/Model")).toBeDefined();
    });
  });
});
