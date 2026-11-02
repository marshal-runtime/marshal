import type { CatalogItem } from "@common/extensions-catalog/marshal-extension-catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Tabs } from "@/components/marshal-ui/marshal-tabs";
import { TelemetryProvider } from "@/services/telemetry";
import {
  TelemetryPath_App,
  TelemetryPath_Extensions,
  TelemetryPath_McpTab,
} from "@/services/telemetry/schema";
import { RenderScenarioProvider } from "@/services/telemetry/RenderScenarioProvider";
import { createCaptureSink, findUserAction, sinkSetup } from "@/services/telemetry/test-utils";
import { installMockAPIs, render, screen, waitFor, userEvent } from "@/test-utils";

import { McpServersTab } from "./McpServersTab";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

const defaultProps = {
  filteredCatalogMcpServers: [],
  filteredMcpServers: [],
  search: "",
  getInstallState: () => "available" as const,
  onInstallCatalogItem: vi.fn<() => void>(),
  onSelectCatalogItem: vi.fn<() => void>(),
  onSelectCustomServer: vi.fn<() => void>(),
  addingMcp: false,
  onAddMcpOpen: vi.fn<() => void>(),
  newMcpName: "",
  newMcpUrl: "",
  newMcpCommand: "",
  newMcpBearerToken: "",
  newMcpTimeoutSeconds: "",
  newMcpEnvFile: "",
  newMcpMode: "url" as const,
  newMcpExposeAsNode: false,
  newMcpTransport: "http" as const,
  onNameChange: vi.fn<() => void>(),
  onUrlChange: vi.fn<() => void>(),
  onCommandChange: vi.fn<() => void>(),
  onBearerTokenChange: vi.fn<() => void>(),
  onTimeoutSecondsChange: vi.fn<() => void>(),
  onEnvFileChange: vi.fn<() => void>(),
  onModeChange: vi.fn<() => void>(),
  onExposeAsNodeChange: vi.fn<() => void>(),
  onTransportChange: vi.fn<() => void>(),
  onAddMcpSave: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  onAddMcpClose: vi.fn<() => void>(),
};

function renderMcpServersTab(overrides?: Partial<React.ComponentProps<typeof McpServersTab>>) {
  return render(
    <TelemetryProvider>
      <RenderScenarioProvider view="plugins">
        <TelemetryPath_App>
          <TelemetryPath_Extensions>
            <TelemetryPath_McpTab>
              <Tabs defaultValue="mcp-servers">
                <McpServersTab {...defaultProps} {...overrides} />
              </Tabs>
            </TelemetryPath_McpTab>
          </TelemetryPath_Extensions>
        </TelemetryPath_App>
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
}

describe("McpServersTab telemetry", () => {
  beforeEach(() => {
    events.splice(0);
    installMockAPIs();
  });

  it("emits UserAction for AddMcpServer at /App/Extensions/McpTab", async () => {
    const user = userEvent.setup();
    renderMcpServersTab();
    await user.click(screen.getByText("Add Server"));
    await waitFor(() => {
      expect(findUserAction(events, "AddMcpServer", "/App/Extensions/McpTab")).toBeDefined();
    });
  });

  it("emits UserAction for InstallMcpServer at /App/Extensions/McpTab/ExtensionMcpServer", async () => {
    const user = userEvent.setup();
    const catalogServer: CatalogItem = {
      id: "test-server",
      name: "test-server",
      displayName: "Test Server",
      description: "A test MCP server",
      icon: "🔌",
      author: "Test",
      type: "mcp-servers",
      tags: [],
      source: { type: "bundled" },
    };
    renderMcpServersTab({ filteredCatalogMcpServers: [catalogServer] });
    await user.click(screen.getByText("Install"));
    await waitFor(() => {
      expect(
        findUserAction(events, "InstallMcpServer", "/App/Extensions/McpTab/ExtensionMcpServer"),
      ).toBeDefined();
    });
  });
});
