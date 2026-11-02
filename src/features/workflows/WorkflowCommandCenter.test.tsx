import type { WorkflowsAPI } from "@common/marshal-ipc-contract";
import type { RunSnapshot } from "@common/workflows-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import { render, screen, userEvent } from "@/test-utils";

import { WorkflowCommandCenter } from "./WorkflowCommandCenter";

afterEach(() => {
  vi.restoreAllMocks();
  delete window.workflowsAPI;
});

function installWorkflowsApi(api: Partial<WorkflowsAPI>) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture only supplies APIs used by this component
  window.workflowsAPI = api as WorkflowsAPI;
}

const SNAPSHOT: RunSnapshot = {
  runId: "run-123",
  runFamilyId: "run-123",
  workflowId: "incident-forensics",
  workflowVersion: "1.0.0",
  status: "succeeded",
  startedAt: 0,
  input: null,
  steps: [],
  agents: {},
  artifacts: [],
  capacity: { activeSubagents: 0, globalLimit: 8, perRunLimit: 8, queued: 0 },
  events: { lastSeq: 0 },
  actionCenterItems: [
    {
      id: "action-1",
      title: "Review root cause",
      why: "Evidence needs owner review",
      evidence: [
        {
          label: "Reasoner evidence",
          detail: "Correlated incident details",
          artifacts: [
            {
              runId: "run-123",
              key: "reasoner-output.json",
              label: "Reasoner output",
            },
          ],
          files: [
            {
              path: "C:\\repo\\investigations\\incident-1.md",
              label: "Investigation notes",
            },
          ],
          chats: [],
        },
      ],
      supportingDetails: [],
      artifacts: [],
      chats: [],
      safeToSend: true,
    },
  ],
};

describe("WorkflowCommandCenter", () => {
  it("renders action-center artifact and file references in expansion details", async () => {
    installWorkflowsApi({
      readArtifactByKey: vi.fn<WorkflowsAPI["readArtifactByKey"]>().mockResolvedValue({
        success: false,
        error: "not found",
      }),
      listRuns: vi.fn<WorkflowsAPI["listRuns"]>().mockResolvedValue({ success: true, runs: [] }),
      listState: vi
        .fn<WorkflowsAPI["listState"]>()
        .mockResolvedValue({ success: true, entries: [] }),
    });

    render(<WorkflowCommandCenter runSnapshot={SNAPSHOT} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Actions" }));

    expect(await screen.findByText(/Artifact: Reasoner output/)).toBeInTheDocument();
    expect(screen.getByText(/reasoner-output\.json/)).toBeInTheDocument();
    expect(screen.getByText(/File: Investigation notes/)).toBeInTheDocument();
    expect(screen.getByText(/C:\\repo\\investigations\\incident-1\.md/)).toBeInTheDocument();
  });
});
