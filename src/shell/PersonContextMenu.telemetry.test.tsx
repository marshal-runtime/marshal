import type { UserIdentity } from "@common/marshal-ipc-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TelemetryProvider } from "@/services/telemetry";
import { RenderScenarioProvider } from "@/services/telemetry/RenderScenarioProvider";
import { TelemetryPath_App, TelemetryPath_Nav } from "@/services/telemetry/schema";
import { createCaptureSink, findUserAction, sinkSetup } from "@/services/telemetry/test-utils";
import { installMockAPIs, render, screen, waitFor, userEvent } from "@/test-utils";

import { PersonContextMenu } from "./PersonContextMenu";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

function renderMenu() {
  return render(
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">
        <TelemetryPath_App>
          <TelemetryPath_Nav>
            <PersonContextMenu compact />
          </TelemetryPath_Nav>
        </TelemetryPath_App>
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
}

describe("PersonContextMenu telemetry", () => {
  beforeEach(() => {
    events.splice(0);
    installMockAPIs({
      identityAPI: {
        get: vi.fn<() => Promise<{ success: true; identity: UserIdentity }>>().mockResolvedValue({
          success: true,
          identity: {
            isAuthenticated: true,
            displayName: "Jane Smith",
            subtitle: "janesmith",
            accountName: null,
            avatarUrl: null,
            statusColor: "success",
            statusText: "Connected",
            integrations: [
              { id: "mail", name: "Mail", connected: true },
              { id: "chat", name: "Chat", connected: true },
            ],
            signOut: {
              title: "Sign out?",
              description: "",
              confirmLabel: "Sign out",
            },
          },
        }),
      },
    });
  });

  it("emits UserAction for SignOut at /App/Nav", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "User menu" }));
    await user.click(screen.getByText("Sign out"));
    await waitFor(() => {
      expect(findUserAction(events, "SignOut", "/App/Nav")).toBeDefined();
    });
  });
});
