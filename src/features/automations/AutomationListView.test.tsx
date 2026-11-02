import { describe, expect, it, vi } from "vitest";

import { TelemetryProvider } from "@/services/telemetry";
import { TelemetryPath_App, TelemetryPath_Automations } from "@/services/telemetry/schema";
import { RenderScenarioProvider } from "@/services/telemetry/RenderScenarioProvider";
import { createCaptureSink, sinkSetup } from "@/services/telemetry/test-utils";
import { render, screen } from "@/test-utils";
import type { Skill, AutomationData } from "@/types/electron";

import { AutomationListView } from "./AutomationListView";

const { sinkManager } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

const baseProps = {
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

function renderList(automations: AutomationData[]) {
  return render(
    <TelemetryProvider>
      <RenderScenarioProvider view="automations">
        <TelemetryPath_App>
          <TelemetryPath_Automations>
            <AutomationListView {...baseProps} automations={automations} />
          </TelemetryPath_Automations>
        </TelemetryPath_App>
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
}

describe("AutomationListView — firedAt badge", () => {
  it("renders the 'Fired ...' badge when a condition automation has firedAt set", () => {
    const automation: AutomationData = {
      id: "wf-cond",
      name: "Watcher",
      steps: [{ id: "s1", label: "L", prompt: "do thing" }],
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      enabled: false,
      triggerType: "condition",
      condition: "When email arrives",
      conditionCheckInterval: 15,
      firedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    };

    renderList([automation]);

    expect(screen.getByText(/Fired \d+m ago/)).toBeInTheDocument();
  });

  it("does NOT render the 'Fired' badge when firedAt is unset", () => {
    const automation: AutomationData = {
      id: "wf-cond-unfired",
      name: "Watcher",
      steps: [{ id: "s1", label: "L", prompt: "do thing" }],
      schedule: { naturalLanguage: "every 15m", days: [], hour: 0, minute: 0 },
      enabled: true,
      triggerType: "condition",
      condition: "When email arrives",
      conditionCheckInterval: 15,
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    };

    renderList([automation]);

    expect(screen.queryByText(/Fired/)).not.toBeInTheDocument();
  });
});
