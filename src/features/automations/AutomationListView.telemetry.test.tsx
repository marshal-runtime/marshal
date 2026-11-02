import { beforeEach, describe, expect, it, vi } from "vitest";

import { TelemetryProvider } from "@/services/telemetry";
import { TelemetryPath_App, TelemetryPath_Automations } from "@/services/telemetry/schema";
import { RenderScenarioProvider } from "@/services/telemetry/RenderScenarioProvider";
import { createCaptureSink, findUserAction, sinkSetup } from "@/services/telemetry/test-utils";
import { render, screen, waitFor, userEvent } from "@/test-utils";
import type { Skill, AutomationData } from "@/types/electron";

import { AutomationListView } from "./AutomationListView";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

const mockAutomation: AutomationData = {
  id: "wf-1",
  name: "Daily Summary",
  steps: [],
  schedule: { naturalLanguage: "daily at 9am", days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  triggerType: "schedule",
};

const defaultProps = {
  automations: [] as AutomationData[],
  skills: [],
  runningId: null,
  expandedSkills: new Set<string>(),
  importSummary: null,
  importError: null,
  onClearImportSummary: vi.fn<() => void>(),
  onClearImportError: vi.fn<() => void>(),
  onCreate: vi.fn<() => void>(),
  onEdit: vi.fn<(wf: AutomationData) => void>(),
  onToggle: vi.fn<(id: string, enabled: boolean) => void>(),
  onRunNow: vi.fn<(id: string) => void>(),
  onExport: vi.fn<(id: string) => void>(),
  onDeleteClick: vi.fn<(wf: AutomationData) => void>(),
  onViewHistory: vi.fn<(wf: AutomationData) => void>(),
  onFileSelected: vi.fn<(e: React.ChangeEvent<HTMLInputElement>) => void>(),
  onImportBundle: vi.fn<() => void>(),
  onGithubImport: vi.fn<() => void>(),
  onToggleSkills: vi.fn<(wfId: string) => void>(),
  getAutomationSkills: vi.fn<(wf: AutomationData) => Skill[]>().mockReturnValue([]),
};

function renderList(overrides: Partial<typeof defaultProps> = {}) {
  return render(
    <TelemetryProvider>
      <RenderScenarioProvider view="automations">
        {/* AutomationListView wraps itself in TelemetryPath_List */}
        <TelemetryPath_App>
          <TelemetryPath_Automations>
            <AutomationListView {...defaultProps} {...overrides} />
          </TelemetryPath_Automations>
        </TelemetryPath_App>
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
}

describe("AutomationListView telemetry", () => {
  beforeEach(() => {
    events.splice(0);
  });

  it("emits UserAction for New at /App/Automations/List", async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(await screen.findByText("New automation"));
    await waitFor(() => {
      expect(findUserAction(events, "New", "/App/Automations/List")).toBeDefined();
    });
  });

  it("emits UserAction for Import at /App/Automations/List", async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(await screen.findByText("Import"));
    await waitFor(() => {
      expect(findUserAction(events, "Import", "/App/Automations/List")).toBeDefined();
    });
  });

  it("emits UserAction for Edit at /App/Automations/List/0/Automation", async () => {
    const user = userEvent.setup();
    renderList({ automations: [mockAutomation] });
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(findUserAction(events, "Edit", "/App/Automations/List/0/Automation")).toBeDefined();
    });
  });
});
