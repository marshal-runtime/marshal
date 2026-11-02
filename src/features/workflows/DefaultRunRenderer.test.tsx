// src/features/workflows/DefaultRunRenderer.test.tsx
//
// Renders DefaultRunRenderer against a hand-rolled RunSnapshot fixture and
// verifies the three columns surface step / agent / artifact data.

import type { RunActions, RunSnapshot } from "@common/workflows-contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { TooltipProvider } from "@/components/marshal-ui/marshal-tooltip";

import { DefaultRunRenderer } from "./DefaultRunRenderer";

// The center pane embeds the real `ChatPanel`. Stub it here so the renderer's
// step/agent/artifact wiring is unit-testable without the full chat/session/
// IPC stack — the stub records the session id it was mounted with.
const { chatPanelSessions } = vi.hoisted(() => ({ chatPanelSessions: [] as Array<string | null> }));
vi.mock("@/features/chat", () => ({
  ChatPanel: (props: { sessionId?: string | null }) => {
    chatPanelSessions.push(props.sessionId ?? null);
    return null;
  },
}));

const SNAPSHOT: RunSnapshot = {
  runId: "r1",
  runFamilyId: "r1",
  workflowId: "wf",
  workflowVersion: "1.0.0",
  status: "running",
  startedAt: 0,
  input: null,
  steps: [
    {
      id: "s1",
      label: "load",
      parentStepKey: "",
      depth: 0,
      status: "succeeded",
      kind: "sequential",
      startedAt: 0,
      endedAt: 1000,
      retryCount: 0,
      directAgents: ["sess-a"],
      artifacts: [],
    },
    {
      id: "s2",
      label: "fan",
      parentStepKey: "",
      depth: 0,
      status: "running",
      kind: "fanOut",
      startedAt: 1000,
      retryCount: 0,
      units: [
        {
          handleId: "h1",
          itemKey: "u1",
          status: "running",
          sessionId: "sess-b",
          startedAt: 1100,
          finishedAt: null,
        },
      ],
      directAgents: [],
      artifacts: [],
    },
  ],
  agents: {
    "sess-a": {
      handleId: "sess-a",
      sessionId: "sess-a",
      stepKey: "s1",
      identity: "loader",
      status: "completed",
      turnCount: 1,
      lastMessageAt: 999,
    },
    "sess-b": {
      handleId: "sess-b",
      sessionId: "sess-b",
      stepKey: "s2",
      identity: "fanWorker",
      status: "running",
      turnCount: 0,
      lastMessageAt: null,
    },
  },
  capacity: {
    used: 1,
    cap: 8,
    queueLength: 0,
    activeSubagents: 1,
    globalLimit: 8,
    perRunLimit: 8,
    queued: 0,
  },
  artifacts: [
    {
      key: "summary.md",
      storageKey: "/runs/r1/summary.md",
      namespace: "run",
      mime: "text/markdown",
      writtenAt: 1500,
      sizeBytes: 128,
    },
  ],
  events: { lastSeq: 5 },
};

const ACTIONS: RunActions = {
  cancel: vi.fn<(reason?: string) => Promise<void>>(),
  retryFromStep: vi.fn<(stepId: string) => Promise<{ newRunId: string; runFamilyId: string }>>(),
  openSubagentChat: vi.fn<(sessionId: string) => void>(),
};

describe("DefaultRunRenderer", () => {
  beforeEach(() => {
    chatPanelSessions.length = 0;
  });

  test("renders step rail, agent grid, and artifact list", () => {
    render(
      <TooltipProvider>
        <DefaultRunRenderer runSnapshot={SNAPSHOT} actions={ACTIONS} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: /Step load/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Step fan/i })).toBeInTheDocument();
    // Default selection is the newest running step (`fan`), so unit `u1` shows up.
    expect(screen.getByRole("button", { name: /Unit u1/i })).toBeInTheDocument();
    expect(screen.getByText("summary.md")).toBeInTheDocument();
  });

  test("empty snapshot shows friendly empty states", () => {
    const empty: RunSnapshot = {
      ...SNAPSHOT,
      steps: [],
      agents: {},
      artifacts: [],
    };
    render(
      <TooltipProvider>
        <DefaultRunRenderer runSnapshot={empty} actions={ACTIONS} />
      </TooltipProvider>,
    );
    expect(screen.getByText(/No steps yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No artifacts produced yet/i)).toBeInTheDocument();
  });

  test("embeds the selected sub-agent's session and wires the Chat-tab pop-out", async () => {
    const snapshot: RunSnapshot = {
      ...SNAPSHOT,
      steps: [
        {
          id: "s1",
          label: "collect",
          parentStepKey: "",
          depth: 0,
          status: "running",
          kind: "sequential",
          startedAt: 0,
          retryCount: 0,
          directAgents: ["h-collect"],
          artifacts: [],
        },
      ],
      agents: {
        "h-collect": {
          handleId: "h-collect",
          sessionId: "sess-collect",
          stepKey: "s1",
          identity: "collector",
          status: "running",
          turnCount: 2,
          lastMessageAt: 1234,
        },
      },
    };
    const actions: RunActions = {
      cancel: vi.fn<(reason?: string) => Promise<void>>(),
      retryFromStep:
        vi.fn<(stepId: string) => Promise<{ newRunId: string; runFamilyId: string }>>(),
      openSubagentChat: vi.fn<(sessionId: string) => void>(),
    };

    render(
      <TooltipProvider>
        <DefaultRunRenderer runSnapshot={snapshot} actions={actions} />
      </TooltipProvider>,
    );

    // The real ChatPanel is mounted pointed at the selected agent's session.
    expect(chatPanelSessions).toContain("sess-collect");

    // The pop-out forwards the same session id to the host's openSubagentChat.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Open in Chat tab/i }));
    expect(actions.openSubagentChat).toHaveBeenCalledWith("sess-collect");
  });

  test("scopes the artifact rail to the selected step, with an All toggle", async () => {
    const snapshot: RunSnapshot = {
      ...SNAPSHOT,
      steps: [
        {
          id: "s1",
          label: "collect",
          parentStepKey: "",
          depth: 0,
          status: "running",
          kind: "sequential",
          startedAt: 0,
          retryCount: 0,
          directAgents: [],
          artifacts: ["collector-output.json"],
        },
      ],
      agents: {},
      artifacts: [
        {
          key: "collector-output.json",
          storageKey: "/runs/r1/collector-output.json",
          namespace: "run",
          mime: "application/json",
          writtenAt: 1200,
          sizeBytes: 64,
          stepKey: "s1",
        },
        {
          key: "incident-fetcher-output.json",
          storageKey: "/runs/r1/incident-fetcher-output.json",
          namespace: "run",
          mime: "application/json",
          writtenAt: 1100,
          sizeBytes: 64,
          stepKey: "other",
        },
      ],
    };

    render(
      <TooltipProvider>
        <DefaultRunRenderer runSnapshot={snapshot} actions={ACTIONS} />
      </TooltipProvider>,
    );

    // Defaults to the selected step's own artifact only.
    expect(screen.getByText("collector-output.json")).toBeInTheDocument();
    expect(screen.queryByText("incident-fetcher-output.json")).not.toBeInTheDocument();

    // Toggling to "All" reveals every run artifact.
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /All \(2\)/i }));
    expect(screen.getByText("incident-fetcher-output.json")).toBeInTheDocument();
  });
});
