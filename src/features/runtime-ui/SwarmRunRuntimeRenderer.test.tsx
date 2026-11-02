import type { RuntimeUiInstance, RuntimeUiJsonValue } from "@common/runtime-ui";
import { SWARM_RUN_VIEW_RENDER_ID } from "@marshal/swarm/presentation";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

import { render, screen, userEvent } from "@/test-utils";

import type { MarshalRuntimeEditorSourceProps } from "./RuntimeEditor";
import type { RuntimeUiApplicationRenderHost } from "./RuntimeUiApplicationRegistry";
import { swarmRunRuntimeUiRenderer } from "./SwarmRunRuntimeRenderer";

it("traverses dependencies and loads transcript files only when clicked", async () => {
  const instance: RuntimeUiInstance = {
    instanceId: "panel",
    owner: {
      sessionId: "session",
      workspaceName: "workspace",
      extensionId: "@marshal/swarm",
      applicationId: "swarm-run",
    },
    surface: "panel",
    revision: 1,
    openedAt: "now",
    updatedAt: "now",
    focusedAt: "now",
    idempotencyKey: "open",
    content: {
      kind: "application",
      renderId: SWARM_RUN_VIEW_RENDER_ID,
      resource: { uri: "ui://marshal/swarm/run", mimeType: "text/html" },
      descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
      state: {
        run: {
          runId: "run",
          objective: "Objective",
          scope: "workspace",
          state: "completed",
          tasks: [
            {
              taskId: "root",
              role: "planner",
              objective: "Plan",
              scope: "workspace",
              state: "completed",
              childTaskIds: ["child"],
              dependencyTaskIds: [],
              artifactRefs: [
                { kind: "report", uri: "/evidence/report.md", summary: "Report document" },
              ],
              executions: [
                {
                  executionId: "exec",
                  sessionId: "agent-session",
                  model: "model-a",
                  reasoningEffort: "high",
                  transcriptRef: "/evidence/session.json",
                  usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 5 },
                },
              ],
              changeRefs: ["commit-abc"],
            },
            {
              taskId: "child",
              parentTaskId: "root",
              role: "worker",
              objective: "Implement",
              scope: "workspace",
              state: "blocked",
              reason: "Waiting for review",
              dependencyTaskIds: ["root"],
              childTaskIds: [],
              artifactRefs: [],
              executions: [],
            },
          ],
        },
      },
    },
  };
  const invokeCapability = vi
    .fn<RuntimeUiApplicationRenderHost["invokeCapability"]>()
    .mockResolvedValue({ output: { text: "Transcript content", truncated: false } });
  const openSession = vi
    .fn<NonNullable<RuntimeUiApplicationRenderHost["openSession"]>>()
    .mockResolvedValue(undefined);
  const SourceEditor = vi.fn<(props: MarshalRuntimeEditorSourceProps) => ReactNode>(
    ({ source }) => <div data-testid="injected-editor">{source.content}</div>,
  );
  const host: RuntimeUiApplicationRenderHost = {
    instance,
    editor: { id: "test", SourceEditor },
    openSession,
    invokeCapability,
    readResource: async () => {
      throw new Error("unused");
    },
    subscribe: () => () => {},
    focus: async () => {},
    close: async () => {},
    update: async () => {},
  };
  render(<>{swarmRunRuntimeUiRenderer({ instance, host })}</>);
  await userEvent.click(screen.getByRole("button", { name: /planner: Plan/ }));
  await userEvent.click(screen.getByText("planner details · usage, executions, outputs"));
  await userEvent.click(screen.getByText("Run details · usage and diagnostics"));
  expect(screen.getByText(/Input tokens: 10/)).toHaveTextContent(
    "Cache tokens (subset of input): 5",
  );
  expect(screen.getByRole("region", { name: "Run usage" })).toHaveTextContent("Input: 10");
  expect(screen.getByRole("region", { name: "Run usage" })).toHaveTextContent(
    "Reported cost (USD): Unknown",
  );
  expect(screen.getByRole("region", { name: "Node usage" })).toHaveTextContent(
    "Cached input (subset of input): 5",
  );
  expect(screen.getByText("commit-abc")).toBeInTheDocument();
  expect(invokeCapability).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: /Open transcript file/ }));
  expect(await screen.findByTestId("injected-editor")).toHaveTextContent("Transcript content");
  expect(SourceEditor.mock.calls.at(-1)?.[0].source).toEqual({
    path: "/evidence/session.json",
    content: "Transcript content",
    language: "json",
  });
  expect(invokeCapability).toHaveBeenCalledWith(
    expect.objectContaining({
      capability: "swarm.runs.read-file",
      input: { runId: "run", taskId: "root", uri: "/evidence/session.json", offset: 0 },
    }),
  );
  expect(
    screen.queryByRole("navigation", { name: "Agent ownership tree" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Back to swarm" }));
  await userEvent.click(screen.getByRole("button", { name: /Report document/ }));
  expect(invokeCapability).toHaveBeenLastCalledWith(
    expect.objectContaining({
      capability: "swarm.runs.read-file",
      input: { runId: "run", taskId: "root", uri: "/evidence/report.md", offset: 0 },
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Back to swarm" }));
  await userEvent.click(screen.getByRole("button", { name: /planner: Plan/ }));
  expect(openSession).toHaveBeenCalledWith("agent-session");
  await userEvent.click(screen.getByRole("button", { name: /worker: Implement/ }));
  await userEvent.click(screen.getByText("worker details · usage, executions, outputs"));
  expect(screen.getByText("Reason: Waiting for review")).toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("button", { name: "root" })[0]);
  await userEvent.click(screen.getByText("planner details · usage, executions, outputs"));
  expect(screen.getByText(/Model: model-a/)).toBeInTheDocument();
  invokeCapability.mockRejectedValueOnce(new Error("File read failed"));
  await userEvent.click(screen.getByRole("button", { name: /Open transcript file/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("File read failed");
  expect(screen.getByRole("navigation", { name: "Agent ownership tree" })).toBeInTheDocument();
});

function outcomeInstance(run: RuntimeUiJsonValue): RuntimeUiInstance {
  return {
    instanceId: "outcome-view",
    owner: {
      sessionId: "session",
      workspaceName: "workspace",
      extensionId: "@marshal/swarm",
      applicationId: "swarm-run",
    },
    surface: "panel",
    revision: 1,
    openedAt: "now",
    updatedAt: "now",
    focusedAt: "now",
    idempotencyKey: "open",
    content: {
      kind: "application",
      renderId: SWARM_RUN_VIEW_RENDER_ID,
      resource: { uri: "ui://marshal/swarm/run", mimeType: "text/html" },
      descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
      state: { run },
    },
  };
}

function outcomeHost(instance: RuntimeUiInstance): RuntimeUiApplicationRenderHost {
  return {
    instance,
    editor: { id: "test", SourceEditor: () => null },
    invokeCapability: async () => ({ output: {} }),
    readResource: async () => {
      throw new Error("unused");
    },
    subscribe: () => () => {},
    focus: async () => {},
    close: async () => {},
    update: async () => {},
  };
}

const failedRunWithOutcome: { readonly [key: string]: RuntimeUiJsonValue } & {
  readonly outcome: { readonly [key: string]: RuntimeUiJsonValue };
} = {
  runId: "run",
  objective: "Ship the fix",
  scope: "workspace",
  state: "failed",
  tasks: [
    {
      taskId: "worker-1",
      role: "worker",
      objective: "Implement change",
      scope: "workspace",
      state: "failed",
      reason: "Tests failed",
      childTaskIds: [],
      dependencyTaskIds: [],
      artifactRefs: [],
      executions: [],
    },
  ],
  outcome: {
    taskCounts: { completed: 3, failed: 2 },
    totalTasks: 5,
    failedTasks: [
      { taskId: "worker-1", role: "worker", objective: "Implement change", reason: "Tests failed" },
      { taskId: "worker-2", role: "reviewer", objective: "Review change" },
    ],
    failedTasksOmitted: 1,
    headline: "Execution failed (3 of 5 tasks completed, 3 failed).",
  },
};

it("renders the published outcome summary through the host", () => {
  const instance = outcomeInstance(failedRunWithOutcome);
  render(<>{swarmRunRuntimeUiRenderer({ instance, host: outcomeHost(instance) })}</>);
  expect(screen.getByTestId("swarm-outcome-headline")).toHaveTextContent(
    "Execution failed (3 of 5 tasks completed, 3 failed).",
  );
  const failed = screen.getByTestId("swarm-outcome-failed");
  expect(failed).toHaveTextContent("Failed — worker: Implement change (Tests failed)");
  expect(failed).toHaveTextContent("Failed — reviewer: Review change");
  expect(failed).toHaveTextContent("…and 1 more failed task.");
});

it("still renders legacy runs without an outcome summary", () => {
  const { outcome: _outcome, ...legacyRun } = failedRunWithOutcome;
  const instance = outcomeInstance(legacyRun);
  render(<>{swarmRunRuntimeUiRenderer({ instance, host: outcomeHost(instance) })}</>);
  expect(screen.getByText("Ship the fix")).toBeInTheDocument();
  expect(screen.queryByTestId("swarm-outcome-summary")).not.toBeInTheDocument();
});

it.each([
  ["totalTasks is not a count", { ...failedRunWithOutcome.outcome, totalTasks: -1 }],
  ["totalTasks is fractional", { ...failedRunWithOutcome.outcome, totalTasks: 2.5 }],
  [
    "a task count is not a safe integer",
    { ...failedRunWithOutcome.outcome, taskCounts: { failed: Number.MAX_SAFE_INTEGER + 2 } },
  ],
  [
    "done and completed alias counts overflow when summed",
    {
      ...failedRunWithOutcome.outcome,
      taskCounts: { done: Number.MAX_SAFE_INTEGER, completed: Number.MAX_SAFE_INTEGER },
    },
  ],
  [
    "failedTasksOmitted is fractional",
    { ...failedRunWithOutcome.outcome, failedTasksOmitted: 0.5 },
  ],
  ["failedTasks is not an array", { ...failedRunWithOutcome.outcome, failedTasks: "broken" }],
  [
    "a failed task identity is malformed",
    { ...failedRunWithOutcome.outcome, failedTasks: [{ role: "worker" }] },
  ],
  [
    "taskCounts holds an unknown state",
    { ...failedRunWithOutcome.outcome, taskCounts: { exploded: 2 } },
  ],
  ["headline is not text", { ...failedRunWithOutcome.outcome, headline: { html: "<b>x</b>" } }],
] as const)("drops a malformed outcome (%s) but keeps the run", (_name, outcome) => {
  const instance = outcomeInstance({ ...failedRunWithOutcome, outcome });
  render(<>{swarmRunRuntimeUiRenderer({ instance, host: outcomeHost(instance) })}</>);
  expect(screen.getByText("Ship the fix")).toBeInTheDocument();
  expect(screen.queryByTestId("swarm-outcome-summary")).not.toBeInTheDocument();
});

it.each(["running", "paused", "blocked"] as const)(
  "renders %s and surfaces failed run controls",
  async (state) => {
    const instance: RuntimeUiInstance = {
      instanceId: "control-view",
      owner: {
        sessionId: "session",
        workspaceName: "workspace",
        extensionId: "@marshal/swarm",
        applicationId: "swarm-run",
      },
      surface: "panel",
      revision: 1,
      openedAt: "now",
      updatedAt: "now",
      focusedAt: "now",
      idempotencyKey: "open",
      content: {
        kind: "application",
        renderId: SWARM_RUN_VIEW_RENDER_ID,
        resource: { uri: "ui://marshal/swarm/run", mimeType: "text/html" },
        descriptor: { version: "1.0.0", presentationModes: ["pip"], actions: [], tools: [] },
        state: {
          run: { runId: "run", objective: "Run controls", scope: "workspace", state, tasks: [] },
        },
      },
    };
    const invokeCapability = vi
      .fn<RuntimeUiApplicationRenderHost["invokeCapability"]>()
      .mockRejectedValue(new Error("Run control failed"));
    const host: RuntimeUiApplicationRenderHost = {
      instance,
      editor: { id: "test", SourceEditor: () => null },
      invokeCapability,
      readResource: async () => {
        throw new Error("unused");
      },
      subscribe: () => () => {},
      focus: async () => {},
      close: async () => {},
      update: async () => {},
    };
    render(<>{swarmRunRuntimeUiRenderer({ instance, host })}</>);
    expect(screen.getByText(state)).toBeInTheDocument();
    let error: HTMLElement | null = null;
    if (state !== "blocked") {
      await userEvent.click(
        screen.getByRole("button", { name: state === "running" ? "Pause swarm" : "Resume swarm" }),
      );
      error = await screen.findByRole("alert");
    }
    expect(error?.textContent).toBe(state === "blocked" ? undefined : "Error: Run control failed");
  },
);
