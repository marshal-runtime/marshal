import { beforeEach, describe, expect, it, vi } from "vitest";

import { TelemetryProvider } from "@/services/telemetry";
import { TelemetryPath_App } from "@/services/telemetry/schema";
import { RenderScenarioProvider } from "@/services/telemetry/RenderScenarioProvider";
import { createCaptureSink, findUserAction, sinkSetup } from "@/services/telemetry/test-utils";
import {
  ALL_CONTROLLABLE_MOCK,
  createMockBackendAPI,
  installMockAPIs,
  render,
  screen,
  waitFor,
  userEvent,
} from "@/test-utils";
import type { HeartbeatAPI } from "@/types/electron";

import { HeartbeatPanel } from "./HeartbeatPanel";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

function renderPanel(heartbeatOverrides = {}) {
  // Install an explicit backendAPI mock so this test doesn't lean
  // on `useAutomationCapabilities`'s `ALL_ENABLED` loading-state default to
  // surface the Run Now button. If `ALL_ENABLED.heartbeatRunNow` ever flips
  // to `false`, the test would otherwise fail for the wrong reason.
  installMockAPIs({ heartbeatAPI: heartbeatOverrides, backendAPI: createMockBackendAPI() });
  return render(
    <TelemetryProvider>
      <RenderScenarioProvider view="heartbeat">
        {/* HeartbeatPanel wraps itself in TelemetryPath_Heartbeat */}
        <TelemetryPath_App>
          <HeartbeatPanel isOpen={true} />
        </TelemetryPath_App>
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
}

describe("HeartbeatPanel telemetry", () => {
  beforeEach(() => {
    events.splice(0);
  });

  it("emits UserAction for Enable at /App/Heartbeat", async () => {
    const user = userEvent.setup();
    // Provide a prompt so Enable button is not disabled
    renderPanel({
      getSettings: vi.fn<HeartbeatAPI["getSettings"]>().mockResolvedValue({
        success: true,
        settings: {
          supported: true,
          intervalMinutes: 30,
          schedule: "work-hours",
          prompt: "Check inbox",
          controllable: ALL_CONTROLLABLE_MOCK,
        },
      }),
    });
    await user.click(await screen.findByText("Enable"));
    await waitFor(() => {
      expect(findUserAction(events, "Enable", "/App/Heartbeat")).toBeDefined();
    });
  });

  it("emits UserAction for Trigger at /App/Heartbeat", async () => {
    const user = userEvent.setup();
    // Override settings to have a non-empty prompt so "Run now" is enabled
    renderPanel({
      getSettings: vi.fn<HeartbeatAPI["getSettings"]>().mockResolvedValue({
        success: true,
        settings: {
          supported: true,
          intervalMinutes: 30,
          schedule: "work-hours",
          prompt: "Check emails",
          controllable: ALL_CONTROLLABLE_MOCK,
        },
      }),
    });
    await user.click(await screen.findByText("Run now"));
    await waitFor(() => {
      expect(findUserAction(events, "Trigger", "/App/Heartbeat")).toBeDefined();
    });
  });

  it("emits UserAction for Save at /App/Heartbeat", async () => {
    const user = userEvent.setup();
    renderPanel();
    // Type in the prompt textarea to make it dirty — Save button appears
    const textarea = await screen.findByRole("textbox");
    await user.type(textarea, "Check my emails");
    await user.click(await screen.findByText("Save"));
    await waitFor(() => {
      expect(findUserAction(events, "Save", "/App/Heartbeat")).toBeDefined();
    });
  });
});
