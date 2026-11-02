import type { CatalogItem } from "@common/extensions-catalog/marshal-extension-catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TelemetryProvider } from "@/services/telemetry";
import { TelemetryPath_App, TelemetryPath_Extensions } from "@/services/telemetry/schema";
import { RenderScenarioProvider } from "@/services/telemetry/RenderScenarioProvider";
import { createCaptureSink, findUserAction, sinkSetup } from "@/services/telemetry/test-utils";
import { installMockAPIs, render, screen, waitFor, userEvent } from "@/test-utils";

import { CatalogDetailDialog, CustomDetailDialog } from "./PluginsDetailDialog";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

const skillItem: CatalogItem = {
  id: "test-skill",
  name: "test-skill",
  displayName: "Test Skill",
  description: "A test skill",
  icon: "🧪",
  author: "Test",
  type: "skills",
  tags: [],
  source: { type: "bundled" },
};

const mcpItem: CatalogItem = {
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

function renderCustomDialog(
  itemType: "skills" | "mcp-servers",
  callbacks: Record<string, () => void> = {},
) {
  return render(
    <TelemetryProvider>
      <RenderScenarioProvider view="plugins">
        <TelemetryPath_App>
          <TelemetryPath_Extensions>
            <CustomDetailDialog
              open={true}
              title="Test Item"
              icon="🧪"
              description="Test description"
              itemType={itemType}
              onClose={vi.fn<() => void>()}
              onRemove={callbacks.onRemove ?? vi.fn<() => void>()}
              onEdit={callbacks.onEdit}
              onExport={callbacks.onExport}
              onUse={callbacks.onUse}
            />
          </TelemetryPath_Extensions>
        </TelemetryPath_App>
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
}

function renderCatalogDialog(
  item: CatalogItem,
  installState:
    | "available"
    | "installed"
    | "built-in"
    | "needs-config"
    | "installing" = "available",
) {
  return render(
    <TelemetryProvider>
      <RenderScenarioProvider view="plugins">
        <TelemetryPath_App>
          <TelemetryPath_Extensions>
            <CatalogDetailDialog
              item={item}
              installState={installState}
              onClose={vi.fn<() => void>()}
              onInstall={vi.fn<() => void>()}
              onUninstall={vi.fn<() => void>()}
              onUse={vi.fn<() => void>()}
            />
          </TelemetryPath_Extensions>
        </TelemetryPath_App>
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
}

describe("CustomDetailDialog telemetry", () => {
  beforeEach(() => {
    events.splice(0);
    installMockAPIs();
  });

  it("emits RemoveSkill at /App/Extensions/SkillsTab/ExtensionSkill for skill items", async () => {
    const user = userEvent.setup();
    renderCustomDialog("skills");
    await user.click(screen.getByText("Remove"));
    await waitFor(() => {
      expect(
        findUserAction(events, "RemoveSkill", "/App/Extensions/SkillsTab/ExtensionSkill"),
      ).toBeDefined();
    });
  });

  it("emits EditSkill at /App/Extensions/SkillsTab/ExtensionSkill for skill items", async () => {
    const user = userEvent.setup();
    renderCustomDialog("skills", { onEdit: vi.fn<() => void>() });
    await user.click(screen.getByText("Edit"));
    await waitFor(() => {
      expect(
        findUserAction(events, "EditSkill", "/App/Extensions/SkillsTab/ExtensionSkill"),
      ).toBeDefined();
    });
  });

  it("emits ExportSkill at /App/Extensions/SkillsTab/ExtensionSkill for skill items", async () => {
    const user = userEvent.setup();
    renderCustomDialog("skills", { onExport: vi.fn<() => void>() });
    await user.click(screen.getByText("Export"));
    await waitFor(() => {
      expect(
        findUserAction(events, "ExportSkill", "/App/Extensions/SkillsTab/ExtensionSkill"),
      ).toBeDefined();
    });
  });

  it("emits UseSkill at /App/Extensions/SkillsTab/ExtensionSkill for skill items", async () => {
    const user = userEvent.setup();
    renderCustomDialog("skills", { onUse: vi.fn<() => void>() });
    await user.click(screen.getByText("Use"));
    await waitFor(() => {
      expect(
        findUserAction(events, "UseSkill", "/App/Extensions/SkillsTab/ExtensionSkill"),
      ).toBeDefined();
    });
  });

  it("emits RemoveMcpServer at /App/Extensions/McpTab/ExtensionMcpServer for MCP items", async () => {
    const user = userEvent.setup();
    renderCustomDialog("mcp-servers");
    await user.click(screen.getByText("Remove"));
    await waitFor(() => {
      expect(
        findUserAction(events, "RemoveMcpServer", "/App/Extensions/McpTab/ExtensionMcpServer"),
      ).toBeDefined();
    });
  });
});

describe("CatalogDetailDialog telemetry", () => {
  beforeEach(() => {
    events.splice(0);
    installMockAPIs();
  });

  it("emits InstallSkill at /App/Extensions/SkillsTab/ExtensionSkill for available skill", async () => {
    const user = userEvent.setup();
    renderCatalogDialog(skillItem, "available");
    await user.click(screen.getByText("Install"));
    await waitFor(() => {
      expect(
        findUserAction(events, "InstallSkill", "/App/Extensions/SkillsTab/ExtensionSkill"),
      ).toBeDefined();
    });
  });

  it("emits UninstallSkill at /App/Extensions/SkillsTab/ExtensionSkill for installed skill", async () => {
    const user = userEvent.setup();
    renderCatalogDialog(skillItem, "installed");
    await user.click(screen.getByText("Uninstall"));
    await waitFor(() => {
      expect(
        findUserAction(events, "UninstallSkill", "/App/Extensions/SkillsTab/ExtensionSkill"),
      ).toBeDefined();
    });
  });

  it("emits InstallMcpServer at /App/Extensions/McpTab/ExtensionMcpServer for available MCP", async () => {
    const user = userEvent.setup();
    renderCatalogDialog(mcpItem, "available");
    await user.click(screen.getByText("Install"));
    await waitFor(() => {
      expect(
        findUserAction(events, "InstallMcpServer", "/App/Extensions/McpTab/ExtensionMcpServer"),
      ).toBeDefined();
    });
  });

  it("emits UninstallMcpServer at /App/Extensions/McpTab/ExtensionMcpServer for installed MCP", async () => {
    const user = userEvent.setup();
    renderCatalogDialog(mcpItem, "installed");
    await user.click(screen.getByText("Uninstall"));
    await waitFor(() => {
      expect(
        findUserAction(events, "UninstallMcpServer", "/App/Extensions/McpTab/ExtensionMcpServer"),
      ).toBeDefined();
    });
  });
});
