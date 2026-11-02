import type { CatalogItem } from "@common/extensions-catalog/marshal-extension-catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Tabs } from "@/components/marshal-ui/marshal-tabs";
import { TelemetryProvider } from "@/services/telemetry";
import {
  TelemetryPath_App,
  TelemetryPath_Extensions,
  TelemetryPath_SkillsTab,
} from "@/services/telemetry/schema";
import { RenderScenarioProvider } from "@/services/telemetry/RenderScenarioProvider";
import { createCaptureSink, findUserAction, sinkSetup } from "@/services/telemetry/test-utils";
import { installMockAPIs, render, screen, waitFor, userEvent } from "@/test-utils";

import { SkillsTab } from "./SkillsTab";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

const defaultProps = {
  filteredCatalogSkills: [],
  filteredCustomSkills: [],
  search: "",
  getInstallState: () => "available" as const,
  onInstallCatalogItem: vi.fn<() => void>(),
  onSelectCatalogItem: vi.fn<() => void>(),
  onSelectCustomSkill: vi.fn<() => void>(),
  onAddSkill: vi.fn<() => void>(),
  onImport: vi.fn<() => void>(),
  showAddSkill: false,
  onAddSkillSave: vi.fn<() => void>(),
  onAddSkillClose: vi.fn<() => void>(),
};

function renderSkillsTab(overrides?: Partial<React.ComponentProps<typeof SkillsTab>>) {
  return render(
    <TelemetryProvider>
      <RenderScenarioProvider view="plugins">
        <TelemetryPath_App>
          <TelemetryPath_Extensions>
            <TelemetryPath_SkillsTab>
              <Tabs defaultValue="skills">
                <SkillsTab {...defaultProps} {...overrides} />
              </Tabs>
            </TelemetryPath_SkillsTab>
          </TelemetryPath_Extensions>
        </TelemetryPath_App>
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
}

describe("SkillsTab telemetry", () => {
  beforeEach(() => {
    events.splice(0);
    installMockAPIs();
  });

  it("emits UserAction for AddSkill at /App/Extensions/SkillsTab", async () => {
    const user = userEvent.setup();
    renderSkillsTab();
    await user.click(screen.getByText("Add Skill"));
    await waitFor(() => {
      expect(findUserAction(events, "AddSkill", "/App/Extensions/SkillsTab")).toBeDefined();
    });
  });

  it("emits UserAction for ImportSkill at /App/Extensions/SkillsTab", async () => {
    const user = userEvent.setup();
    renderSkillsTab();
    await user.click(screen.getByText("Import"));
    await waitFor(() => {
      expect(findUserAction(events, "ImportSkill", "/App/Extensions/SkillsTab")).toBeDefined();
    });
  });

  it("emits UserAction for InstallSkill at /App/Extensions/SkillsTab/ExtensionSkill", async () => {
    const user = userEvent.setup();
    const catalogSkill: CatalogItem = {
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
    renderSkillsTab({ filteredCatalogSkills: [catalogSkill] });
    expect(screen.getByText("Bundled Skills")).toBeInTheDocument();
    await user.click(screen.getByText("Install"));
    await waitFor(() => {
      expect(
        findUserAction(events, "InstallSkill", "/App/Extensions/SkillsTab/ExtensionSkill"),
      ).toBeDefined();
    });
  });
});
