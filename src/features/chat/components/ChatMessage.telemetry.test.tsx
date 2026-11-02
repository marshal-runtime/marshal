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
import {
  installMockAPIs,
  installMockClipboard,
  render,
  screen,
  waitFor,
  userEvent,
} from "@/test-utils";

import { ChatMessage, type Message } from "./ChatMessage";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

const assistantMessage: Message = {
  id: "msg-1",
  role: "assistant",
  content: "Hello, how can I help?",
  timestamp: new Date(),
};

function renderMessage(message = assistantMessage) {
  return render(
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">
        <TelemetryPath_App>
          <TelemetryPath_Chat>
            <TelemetryPath_Messages>
              <TelemetryPath_Message>
                <ChatMessage message={message} />
              </TelemetryPath_Message>
            </TelemetryPath_Messages>
          </TelemetryPath_Chat>
        </TelemetryPath_App>
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
}

describe("ChatMessage telemetry", () => {
  beforeEach(() => {
    // Defensive: ensure window.telemetryAPI is fresh for this test (worker
    // isolation alone isn't enough — a prior test in the same worker could
    // leave a partial API installed on window).
    installMockAPIs();
    events.splice(0);
    installMockClipboard();
  });

  it("emits UserAction for Copy at /App/Chat/Messages/Message", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderMessage();
    await screen.findByTestId("message-assistant");
    await user.click(screen.getByTestId("copy-message-btn"));
    await waitFor(() => {
      expect(findUserAction(events, "Copy", "/App/Chat/Messages/Message")).toBeDefined();
    });
  });
});
