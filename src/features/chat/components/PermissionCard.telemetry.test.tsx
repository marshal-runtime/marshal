import { beforeEach, describe, expect, it, vi } from "vitest";

import { TelemetryProvider } from "@/services/telemetry";
import {
  TelemetryPath_App,
  TelemetryPath_Chat,
  TelemetryPath_Messages,
  TelemetryPath_Message,
} from "@/services/telemetry/schema";
import { RenderScenarioProvider } from "@/services/telemetry/RenderScenarioProvider";
import { createCaptureSink, findUserAction, sinkSetup } from "@/services/telemetry/test-utils";
import { render, screen, waitFor, userEvent } from "@/test-utils";
import type { PermissionCardData } from "@/types/electron";

import { PermissionCard } from "./PermissionCard";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

const mockRequest: PermissionCardData = {
  id: "req-1",
  kind: "shell",
  title: "Run shell command",
  message: "Allow running a terminal command?",
  detail: "echo hello",
  buttons: ["Allow", "Deny", "Always allow"],
};

function renderCard(request = mockRequest) {
  return render(
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">
        {/* PermissionCard wraps itself in TelemetryPath_PermissionCard */}
        <TelemetryPath_App>
          <TelemetryPath_Chat>
            <TelemetryPath_Messages>
              <TelemetryPath_Message>
                <PermissionCard
                  request={request}
                  onRespond={vi.fn<(id: string, action: string) => void>()}
                />
              </TelemetryPath_Message>
            </TelemetryPath_Messages>
          </TelemetryPath_Chat>
        </TelemetryPath_App>
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
}

describe("PermissionCard telemetry", () => {
  beforeEach(() => {
    events.splice(0);
  });

  it("emits UserAction for Accept at /App/Chat/Messages/Message/PermissionCard", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => {
      expect(
        findUserAction(events, "Accept", "/App/Chat/Messages/Message/PermissionCard"),
      ).toBeDefined();
    });
  });

  it("emits UserAction for Deny at /App/Chat/Messages/Message/PermissionCard", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => {
      expect(
        findUserAction(events, "Deny", "/App/Chat/Messages/Message/PermissionCard"),
      ).toBeDefined();
    });
  });

  it("emits UserAction for AlwaysAllow at /App/Chat/Messages/Message/PermissionCard", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "Choose access scope" }));
    await user.click(screen.getByRole("menuitem", { name: /All chats/ }));
    await waitFor(() => {
      expect(
        findUserAction(events, "AlwaysAllow", "/App/Chat/Messages/Message/PermissionCard"),
      ).toBeDefined();
    });
  });
});
