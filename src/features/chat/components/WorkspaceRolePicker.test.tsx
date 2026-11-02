import type {
  MainSessionWorkspaceBinding,
  RepositoryAgentIdentity,
  SessionRepositoryAgent,
} from "@common/marshal-ipc-contract";
import { DEFAULT_WORKSPACE_DISPLAY_NAME, DEFAULT_WORKSPACE_KEY } from "@common/workspace-display";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent, waitFor } from "@/test-utils";
import type { WorkspaceAPI } from "@/types/electron";

import { WorkspaceRolePicker } from "./WorkspaceRolePicker";

function workspaceBinding(name: string, inode: string): MainSessionWorkspaceBinding {
  return {
    name,
    identity: {
      version: 1,
      device: "1",
      inode,
      birthtimeNs: "3",
    },
  };
}

function agentIdentity(name: string, path: string, contentDigest: string): RepositoryAgentIdentity {
  return {
    version: 1,
    normalizedPath: path,
    declaredName: name,
    contentDigest,
  };
}

function repositoryAgent(
  name: string,
  path: string,
  contentDigest: string,
): SessionRepositoryAgent {
  return {
    name,
    path,
    description: `${name} role`,
    identity: agentIdentity(name, path, contentDigest),
  };
}

const scratchpad = workspaceBinding("Scratchpad", "1");
const project = workspaceBinding("Project", "2");
const other = workspaceBinding("Other", "3");
const empty = workspaceBinding("Empty", "4");
const marshal = workspaceBinding("marshal", "5");
const pbi = workspaceBinding("PBI", "6");
const powerQuery = workspaceBinding("PowerQuery", "7");
const reviewer = repositoryAgent("Reviewer", ".github/agents/reviewer.agent.md", "reviewer-v1");
const reviewerChanged = repositoryAgent(
  "Reviewer",
  ".github/agents/reviewer.agent.md",
  "reviewer-v2",
);
const builder = repositoryAgent("Builder", ".github/agents/builder.agent.md", "builder-v1");

function renderPicker(overrides: Partial<ComponentProps<typeof WorkspaceRolePicker>> = {}) {
  const onApply = vi.fn<ComponentProps<typeof WorkspaceRolePicker>["onApply"]>(
    async () => undefined,
  );
  render(
    <WorkspaceRolePicker
      sessionId="session-1"
      hasUserMessages={false}
      onApply={onApply}
      {...overrides}
    />,
  );
  return { onApply };
}

async function openPicker() {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("workspace-role-trigger"));
  await screen.findByTestId("workspace-role-dialog");
  return user;
}

async function chooseSelectOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(screen.getByLabelText(label));
  await user.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  vi.clearAllMocks();
  installMockAPIs({
    workspaceAPI: {
      listWorkspaces: vi.fn<WorkspaceAPI["listWorkspaces"]>().mockResolvedValue({
        success: true,
        workspaces: ["Scratchpad", "Project", "Other", "Empty"],
        workspaceBindings: [scratchpad, project, other, empty],
      }),
      listRepositoryAgents: vi
        .fn<WorkspaceAPI["listRepositoryAgents"]>()
        .mockImplementation(async (workspaceName) => ({
          success: true,
          agents:
            workspaceName === "Project" ? [reviewer] : workspaceName === "Other" ? [builder] : [],
        })),
    },
  });
});

describe("WorkspaceRolePicker", () => {
  it("keeps the default composer control compact and can start without a workspace", async () => {
    const { onApply } = renderPicker();
    const trigger = screen.getByTestId("workspace-role-trigger");

    expect(trigger).toHaveTextContent("No workspace · Default");
    // "Compact" means a long workspace name cannot blow out the composer.
    // Assert that mechanism — a width cap plus a truncating label — rather
    // than a specific utility class, which is styling and moves with design.
    expect(trigger.style.maxWidth).not.toBe("");
    expect(trigger.querySelector("span")).toHaveClass("truncate");
    expect(trigger).toHaveAccessibleName(/Chat context: No workspace · Default/i);

    const user = await openPicker();
    expect(screen.getByRole("heading", { name: "Start a new chat" })).toBeInTheDocument();
    expect(screen.getByText(/This chat and any draft stay available/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace")).toHaveTextContent("No workspace");
    expect(screen.getByLabelText("Role")).toBeDisabled();

    const start = screen.getByRole("button", { name: "Start without workspace" });
    expect(start).toBeEnabled();
    await user.click(start);

    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({
        workspaceBinding: undefined,
        repositoryAgent: undefined,
      }),
    );
  });

  it("remains actionable before the first ordinary main session is established", () => {
    renderPicker({ sessionId: null });

    expect(screen.getByTestId("workspace-role-trigger")).toBeEnabled();
  });

  it("shows only the canonical explicit workspace list and an Add workspace action", async () => {
    installMockAPIs({
      workspaceAPI: {
        listWorkspaces: vi.fn<WorkspaceAPI["listWorkspaces"]>().mockResolvedValue({
          success: true,
          workspaces: ["Scratchpad", "marshal", "PBI", "PowerQuery"],
          workspaceBindings: [scratchpad, marshal, pbi, powerQuery],
        }),
      },
    });
    renderPicker();
    const user = await openPicker();

    await user.click(screen.getByLabelText("Workspace"));
    // The default workspace is stored under its original key but must surface
    // under the product-facing display name.
    expect(
      await screen.findByRole("option", { name: DEFAULT_WORKSPACE_DISPLAY_NAME }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: DEFAULT_WORKSPACE_KEY })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "marshal" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "PBI" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "PowerQuery" })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "marshal-final-evidence-review" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "1eacb6d6-8975-4093-beda-9ad72deac778" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Add workspace" })).toBeInTheDocument();
  });

  it("adds an existing folder and selects it immediately", async () => {
    const added = workspaceBinding("NewProject", "8");
    let registered = false;
    installMockAPIs({
      workspaceAPI: {
        listWorkspaces: vi.fn<WorkspaceAPI["listWorkspaces"]>().mockImplementation(async () => ({
          success: true,
          workspaces: registered ? ["Scratchpad", "NewProject"] : ["Scratchpad"],
          workspaceBindings: registered ? [scratchpad, added] : [scratchpad],
        })),
        pickFolder: vi.fn<WorkspaceAPI["pickFolder"]>().mockResolvedValue({
          success: true,
          folderPath: "C:\\src\\NewProject",
          folderToken: "folder-token",
        }),
        createWorkspace: vi.fn<WorkspaceAPI["createWorkspace"]>().mockImplementation(async () => {
          registered = true;
          return { success: true };
        }),
      },
    });
    renderPicker();
    const user = await openPicker();

    await user.click(screen.getByRole("button", { name: "Add workspace" }));

    await waitFor(() =>
      expect(window.workspaceAPI.createWorkspace).toHaveBeenCalledWith(
        "NewProject",
        "folder-token",
      ),
    );
    await waitFor(() => expect(screen.getByLabelText("Workspace")).toHaveTextContent("NewProject"));
  });

  it("disables the trigger while session context is still loading", () => {
    renderPicker({ disabled: true });

    expect(screen.getByTestId("workspace-role-trigger")).toBeDisabled();
  });

  it("starts a new chat with the exact validated current workspace and role", async () => {
    const { onApply } = renderPicker({
      workspaceName: "Project",
      workspaceIdentity: project.identity,
      repositoryAgent: reviewer,
    });

    await waitFor(() =>
      expect(screen.getByTestId("workspace-role-trigger")).toHaveTextContent("Project · Reviewer"),
    );
    const user = await openPicker();
    await waitFor(() => expect(screen.getByLabelText("Workspace")).toHaveTextContent("Project"));
    await waitFor(() => expect(screen.getByLabelText("Role")).toHaveTextContent("Reviewer"));

    const start = screen.getByRole("button", { name: "Select workspace" });
    expect(start).toBeEnabled();
    await user.click(start);

    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({
        workspaceBinding: project,
        repositoryAgent: reviewer,
      }),
    );
  });

  it("resets the role and refreshes choices when the workspace changes", async () => {
    renderPicker();
    const user = await openPicker();

    await chooseSelectOption(user, "Workspace", "Project");
    await waitFor(() =>
      expect(window.workspaceAPI.listRepositoryAgents).toHaveBeenCalledWith("Project"),
    );
    await chooseSelectOption(user, "Role", "Reviewer");
    await chooseSelectOption(user, "Workspace", "Other");

    await waitFor(() =>
      expect(window.workspaceAPI.listRepositoryAgents).toHaveBeenCalledWith("Other"),
    );
    expect(screen.getByLabelText("Role")).toHaveTextContent("Default");
    await user.click(screen.getByLabelText("Role"));
    expect(await screen.findByRole("option", { name: "Builder" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Reviewer" })).not.toBeInTheDocument();
  });

  it("supports Default in a workspace with no repository roles", async () => {
    const { onApply } = renderPicker();
    const user = await openPicker();

    await chooseSelectOption(user, "Workspace", "Empty");
    expect(
      await screen.findByText("No repository roles found. Default is available."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select workspace" }));

    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({
        workspaceBinding: empty,
        repositoryAgent: undefined,
      }),
    );
  });

  it("shows a stale workspace only as previous context and offers safe recovery", async () => {
    const removed = workspaceBinding("Removed workspace", "10");
    const { onApply } = renderPicker({
      workspaceName: removed.name,
      workspaceIdentity: removed.identity,
    });

    await waitFor(() =>
      expect(screen.getByTestId("workspace-role-trigger")).toHaveTextContent("Context unavailable"),
    );
    const user = await openPicker();

    const status = screen.getByTestId("previous-context-status");
    expect(status).toHaveTextContent("Previous context is unavailable");
    expect(status).toHaveTextContent("Workspace");
    expect(status).toHaveTextContent("Removed workspace");
    expect(screen.getByLabelText("Workspace")).toHaveTextContent("No workspace");
    expect(screen.getByLabelText("Role")).toBeDisabled();

    const start = screen.getByRole("button", { name: "Start without workspace" });
    expect(start).toBeEnabled();
    await user.click(start);

    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({
        workspaceBinding: undefined,
        repositoryAgent: undefined,
      }),
    );
  });

  it("does not adopt a same-name workspace replacement until it is explicitly selected", async () => {
    const { onApply } = renderPicker({
      workspaceName: "Project",
      workspaceIdentity: workspaceBinding("Project", "99").identity,
      repositoryAgent: reviewer,
    });

    await waitFor(() =>
      expect(screen.getByTestId("workspace-role-trigger")).toHaveTextContent("Context unavailable"),
    );
    const user = await openPicker();

    expect(screen.getByLabelText("Workspace")).toHaveTextContent("No workspace");
    expect(screen.getByTestId("previous-context-status")).toHaveTextContent("Project");
    await chooseSelectOption(user, "Workspace", "Project");
    expect(screen.getByLabelText("Role")).toHaveTextContent("Default");
    expect(screen.getByRole("button", { name: "Select workspace" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Select workspace" }));

    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({
        workspaceBinding: project,
        repositoryAgent: undefined,
      }),
    );
  });

  it("shows a stale role only as previous context and allows explicit same-name reselection", async () => {
    const { onApply } = renderPicker({
      workspaceName: "Project",
      workspaceIdentity: project.identity,
      repositoryAgent: reviewerChanged,
    });

    await waitFor(() =>
      expect(screen.getByTestId("workspace-role-trigger")).toHaveTextContent("Context unavailable"),
    );
    const user = await openPicker();
    await waitFor(() => expect(screen.getByLabelText("Workspace")).toHaveTextContent("Project"));
    await waitFor(() => expect(screen.getByLabelText("Role")).toHaveTextContent("Default"));

    const status = screen.getByTestId("previous-context-status");
    expect(status.querySelector("dt")).toHaveTextContent("Role");
    expect(status).toHaveTextContent("Role");
    expect(status).toHaveTextContent("Reviewer");

    await chooseSelectOption(user, "Role", "Reviewer");
    expect(screen.getByRole("button", { name: "Select workspace" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Select workspace" }));

    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({
        workspaceBinding: project,
        repositoryAgent: reviewer,
      }),
    );
  });

  it("treats legacy workspace and role metadata without identities as previous context", async () => {
    renderPicker({
      workspaceName: "Project",
      repositoryAgent: {
        name: "Reviewer",
        path: ".github/agents/reviewer.agent.md",
      },
    });

    expect(screen.getByTestId("workspace-role-trigger")).toHaveTextContent("Context unavailable");
    await openPicker();
    expect(screen.getByLabelText("Workspace")).toHaveTextContent("No workspace");
    expect(screen.getByTestId("previous-context-status")).toHaveTextContent("Project");
    expect(screen.getByTestId("previous-context-status")).toHaveTextContent("Reviewer");
  });

  it("uses a portal, stays viewport bounded, and restores trigger focus on close", async () => {
    renderPicker();
    const user = userEvent.setup();
    const trigger = screen.getByTestId("workspace-role-trigger");
    trigger.focus();

    await user.keyboard("{Enter}");
    const dialog = await screen.findByTestId("workspace-role-dialog");

    expect(document.body).toContainElement(dialog);
    expect(dialog).toHaveClass("max-h-[calc(100vh-2rem)]", "overflow-y-auto");
    expect(screen.getByLabelText("Workspace")).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByTestId("workspace-role-dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("states that an existing conversation and draft remain available", async () => {
    renderPicker({ hasUserMessages: true });

    await openPicker();
    expect(screen.getByText(/This conversation and its draft stay available/i)).toBeInTheDocument();
  });

  it("surfaces the Marshal agent soul and writes the chosen one", async () => {
    const onSoulChange = vi.fn<(soulId: string) => void>();
    renderPicker({ onSoulChange });
    const user = await openPicker();

    await waitFor(() =>
      expect(screen.getByTestId("soul-trigger")).toHaveTextContent("Default"),
    );

    await chooseSelectOption(user, "Soul", "Operator");

    await waitFor(() => expect(window.soulAPI.setDefault).toHaveBeenCalledWith("operator"));
    expect(onSoulChange).toHaveBeenCalledWith("operator");
  });

  it("omits the soul control when no soul handler is provided", async () => {
    renderPicker();
    await openPicker();

    expect(screen.queryByTestId("soul-trigger")).not.toBeInTheDocument();
  });

  it("locks the soul once the chat has messages", async () => {
    renderPicker({
      onSoulChange: vi.fn<(soulId: string) => void>(),
      hasUserMessages: true,
    });
    await openPicker();

    expect(screen.getByTestId("soul-trigger")).toBeDisabled();
  });

  it("locks the soul until its context is ready", async () => {
    renderPicker({
      onSoulChange: vi.fn<(soulId: string) => void>(),
      soulContextReady: false,
    });
    await openPicker();

    expect(screen.getByTestId("soul-trigger")).toBeDisabled();
  });
});
