import type { RuntimeUiAPI, SessionMetadata, WorkspaceAPI } from "@common/marshal-ipc-contract";
import { RUNTIME_UI_HOST_PLACEMENTS } from "@common/runtime-ui";
import type {
  RuntimeUiCommandResult,
  RuntimeUiEvent,
  RuntimeUiInstance,
  RuntimeUiPlacementSnapshot,
  RuntimeUiSnapshot,
  RuntimeUiSurface,
} from "@common/runtime-ui";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent, waitFor } from "@/test-utils";

import type { MarshalRuntimeEditor } from "./RuntimeEditor";
import {
  RuntimeUiHost,
  RuntimeUiInlineSurface,
  RuntimeUiPanelSurface,
  RuntimeUiWorkspaceTabs,
} from "./RuntimeUiHost";
import { RuntimeUiRenderer } from "./RuntimeUiRenderer";

const testEditor: MarshalRuntimeEditor = {
  id: "test-editor",
  SourceEditor: () => null,
};

const scope = { sessionId: "session-1", workspaceName: "Workspace One" };
const placementSnapshot: RuntimeUiPlacementSnapshot = {
  revision: 0,
  generatedAt: "2026-08-14T08:00:00.000Z",
  placements: RUNTIME_UI_HOST_PLACEMENTS.map((metadata) => ({
    metadata,
    applications: [],
  })),
  diagnostics: [],
};

function session(): SessionMetadata {
  return {
    id: scope.sessionId,
    name: "Runtime session",
    createdAt: "2026-08-14T08:00:00.000Z",
    updatedAt: "2026-08-14T08:00:00.000Z",
    hasUnread: false,
    isActive: true,
    workspaceName: scope.workspaceName,
  };
}

function applicationContent() {
  return {
    kind: "application" as const,
    renderId: "test-renderer",
    resource: {
      uri: "ui://test/application",
      mimeType: "application/json",
      name: "Test application",
    },
    descriptor: {
      version: "1.0.0" as const,
      presentationModes: ["inline", "fullscreen", "pip"] as const,
      actions: [
        {
          id: "refresh",
          version: "1.0.0",
          title: "Refresh data",
          description: "Refresh authoritative data",
          target: { kind: "capability" as const, capability: "runtime.refresh" },
          inputSchema: { type: "object" as const },
          outputSchema: { type: "object" as const },
          allowedScopes: ["session"] as const,
          requiredPermissions: ["runtime.read"],
          risk: "read" as const,
          idempotency: "supported" as const,
        },
      ],
      tools: [
        {
          id: "lookup",
          name: "Lookup",
          inputSchema: { type: "object" as const },
        },
      ],
      localState: { scope: "workspace" as const, schemaVersion: "2" },
      authoritativeState: {
        capability: "runtime.state.read",
        resourceId: "resource-1",
        version: "7",
      },
    },
    state: {
      count: 3,
      markup: "<script>alert('unsafe')</script>",
    },
  };
}

function instance(
  surface: RuntimeUiSurface,
  applicationId: string,
  overrides: Partial<RuntimeUiInstance> = {},
): RuntimeUiInstance {
  return {
    instanceId: `${surface}-${applicationId}`,
    owner: {
      ...scope,
      extensionId: "extension.one",
      applicationId,
    },
    surface,
    content: { kind: "text", text: `${applicationId} content` },
    idempotencyKey: `open-${surface}-${applicationId}`,
    revision: 4,
    openedAt: "2026-08-14T08:00:00.000Z",
    updatedAt: "2026-08-14T08:00:00.000Z",
    focusedAt: "2026-08-14T08:00:00.000Z",
    ...overrides,
  };
}

function snapshot(instances: readonly RuntimeUiInstance[]): RuntimeUiSnapshot {
  return {
    revision: 10,
    generatedAt: "2026-08-14T08:00:10.000Z",
    scope,
    instances,
    events: [],
  };
}

function commandResult(
  action: RuntimeUiCommandResult["receipt"]["action"],
  value?: RuntimeUiInstance,
): RuntimeUiCommandResult {
  return {
    receipt: {
      receiptId: `receipt-${action}`,
      action,
      status: "applied",
      completedAt: "2026-08-14T08:00:11.000Z",
      revision: 11,
      instanceId: value?.instanceId,
    },
    instance: value,
  };
}

function createRuntimeUiApi(currentSnapshot: RuntimeUiSnapshot) {
  let listener: ((event: RuntimeUiEvent) => void) | undefined;
  const api: RuntimeUiAPI = {
    getSnapshot: vi.fn<RuntimeUiAPI["getSnapshot"]>().mockResolvedValue({
      success: true,
      value: currentSnapshot,
    }),
    subscribe: vi.fn<RuntimeUiAPI["subscribe"]>().mockResolvedValue({
      success: true,
      value: currentSnapshot,
    }),
    unsubscribe: vi.fn<RuntimeUiAPI["unsubscribe"]>().mockResolvedValue({ success: true }),
    open: vi
      .fn<RuntimeUiAPI["open"]>()
      .mockResolvedValue({ success: true, value: commandResult("open") }),
    update: vi.fn<RuntimeUiAPI["update"]>().mockImplementation(async (request) => {
      const target = currentSnapshot.instances.find(
        (candidate) => candidate.instanceId === request.instanceId,
      );
      return {
        success: true,
        value: commandResult(
          "update",
          target ? { ...target, content: request.content, revision: 11 } : undefined,
        ),
      };
    }),
    focus: vi.fn<RuntimeUiAPI["focus"]>().mockImplementation(async (request) => {
      const target = currentSnapshot.instances.find(
        (candidate) => candidate.instanceId === request.instanceId,
      );
      return {
        success: true,
        value: commandResult(
          "focus",
          target
            ? {
                ...target,
                revision: 11,
                focusedAt: "2026-08-14T08:00:11.000Z",
              }
            : undefined,
        ),
      };
    }),
    close: vi
      .fn<RuntimeUiAPI["close"]>()
      .mockResolvedValue({ success: true, value: commandResult("close") }),
    list: vi
      .fn<RuntimeUiAPI["list"]>()
      .mockResolvedValue({ success: true, value: commandResult("list") }),
    getPlacements: vi.fn<RuntimeUiAPI["getPlacements"]>().mockResolvedValue(placementSnapshot),
    activatePlacement: vi.fn<RuntimeUiAPI["activatePlacement"]>(),
    invokeCapability: vi.fn<NonNullable<RuntimeUiAPI["invokeCapability"]>>(),
    readResource: vi.fn<NonNullable<RuntimeUiAPI["readResource"]>>(),
    onEvent: vi
      .fn<RuntimeUiAPI["onEvent"]>()
      .mockImplementation((callback: (event: RuntimeUiEvent) => void) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      }),
  };
  return { api, emit: (event: RuntimeUiEvent) => listener?.(event) };
}

function renderSurfaces(instances: readonly RuntimeUiInstance[]) {
  const runtime = createRuntimeUiApi(snapshot(instances));
  window.runtimeUiAPI = runtime.api;
  render(
    <RuntimeUiHost activeSessionId={scope.sessionId} sessions={[session()]} editor={testEditor}>
      <RuntimeUiWorkspaceTabs>
        <div>Active chat stream</div>
      </RuntimeUiWorkspaceTabs>
      <RuntimeUiInlineSurface />
      <RuntimeUiPanelSurface />
    </RuntimeUiHost>,
  );
  return runtime;
}

describe("Runtime UI renderer and surfaces", () => {
  beforeEach(() => {
    installMockAPIs({
      workspaceAPI: {
        getUIState: vi.fn<WorkspaceAPI["getUIState"]>().mockResolvedValue({
          success: true,
          state: {
            activeWorkspace: scope.workspaceName,
            expandedPaths: {},
            selectedFiles: {},
          },
        }),
      },
    });
  });

  it("renders text, safe markdown, and generic application manifests without unsafe HTML", async () => {
    const text = instance("inline-card", "text-app", {
      content: { kind: "text", text: "<img src=x onerror=alert(1)> plain text" },
    });
    const markdown = instance("fullscreen", "markdown-app", {
      content: {
        kind: "markdown",
        markdown: "**Formatted** <img src=x onerror=alert(1)><script>alert(2)</script>",
      },
    });
    const application = instance("tab", "application-app", {
      content: applicationContent(),
      focusedAt: "2026-08-14T08:00:03.000Z",
    });
    renderSurfaces([text, markdown, application]);

    expect(await screen.findByText("<img src=x onerror=alert(1)> plain text")).toBeInTheDocument();
    expect(await screen.findByText("Formatted")).toBeInTheDocument();
    expect(await screen.findByText("Application contract")).toBeInTheDocument();
    expect(screen.getByText("Refresh data")).toBeInTheDocument();
    expect(screen.getByText("Lookup")).toBeInTheDocument();
    expect(screen.getByText(/workspace · schema 2/)).toBeInTheDocument();
    expect(screen.getByText(/runtime\.state\.read/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh data is unavailable in this host" }),
    ).toBeDisabled();
    expect(screen.queryByText(/alert\(2\)/, { selector: "script" })).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("runtime-ui-state-inspector")).toHaveTextContent(
      "\\u003cscript\\u003e",
    );
  });

  it("integrates inline, fullscreen, workspace-tab, and side-panel surfaces", async () => {
    renderSurfaces([
      instance("inline-card", "inline-app"),
      instance("fullscreen", "fullscreen-app"),
      instance("tab", "tab-app", {
        content: applicationContent(),
        focusedAt: "2026-08-14T08:00:03.000Z",
      }),
      instance("panel", "panel-app"),
    ]);

    expect(await screen.findByTestId("runtime-ui-fullscreen")).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Runtime application fullscreen-app" }),
    ).toHaveFocus();
    expect(screen.getByTestId("runtime-ui-workspace-tabs")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Chat" })).toBeInTheDocument();
    // Application instances label by the resource's human title, not the id.
    expect(screen.getByRole("tab", { name: "Test application" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("runtime-ui-panel")).toHaveAccessibleName("Runtime side panel");
    expect(screen.getByTestId("runtime-ui-inline")).toBeInTheDocument();
  });

  it("renders the fullscreen surface edge-to-edge with safe-area padding on mobile, and Close still works", async () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => true,
      }),
    });
    const view = renderSurfaces([instance("fullscreen", "mobile-app")]);
    const user = userEvent.setup();

    const overlay = await screen.findByTestId("runtime-ui-fullscreen");
    // Edge-to-edge (no outer margin swallowing the safe-area-padded space)
    // and no rounded card chrome — a native full-screen sheet, not a
    // desktop-style centered dialog with margin an iPhone can hide behind.
    expect(overlay.className).toContain("p-0");
    expect(overlay).toHaveStyle({ paddingTop: "env(safe-area-inset-top)" });
    const dialog = screen.getByRole("dialog", { name: "Runtime application mobile-app" });
    expect(dialog.className).toContain("rounded-none");
    expect(dialog.className).toContain("border-0");

    await user.click(screen.getByRole("button", { name: "Close mobile-app" }));
    expect(view.api.close).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "fullscreen-mobile-app" }),
    );
    await waitFor(() => expect(screen.queryByTestId("runtime-ui-fullscreen")).toBeNull());
  });

  it("orders multiple instances by focus and routes switch and close through typed commands", async () => {
    const older = instance("panel", "older-app");
    const newer = instance("panel", "newer-app", {
      focusedAt: "2026-08-14T08:00:02.000Z",
    });
    const view = renderSurfaces([older, newer]);
    const user = userEvent.setup();

    await screen.findByRole("region", { name: "Runtime application newer-app" });
    await user.click(screen.getByRole("tab", { name: "older-app" }));
    expect(view.api.focus).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: older.instanceId }),
    );
    await user.click(screen.getByRole("button", { name: "Close older-app" }));
    expect(view.api.close).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: older.instanceId }),
    );
    expect(
      await screen.findByRole("region", { name: "Runtime application newer-app" }),
    ).toBeInTheDocument();
  });

  it("closes fullscreen content with Escape and returns focus to the previous control", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Previous focus";
    document.body.append(trigger);
    trigger.focus();
    const view = renderSurfaces([instance("fullscreen", "escape-app")]);
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: "Runtime application escape-app" });
    expect(dialog).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(view.api.close).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "fullscreen-escape-app" }),
    );
    await waitFor(() => expect(screen.queryByTestId("runtime-ui-fullscreen")).toBeNull());
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("rolls failed close operations back and exposes an accessible error", async () => {
    const target = instance("panel", "denied-app");
    const runtime = createRuntimeUiApi(snapshot([target]));
    runtime.api.close = vi.fn<RuntimeUiAPI["close"]>().mockResolvedValue({
      success: false,
      error: { code: "permission-denied", message: "The application must remain open." },
    });
    window.runtimeUiAPI = runtime.api;
    render(
      <RuntimeUiHost activeSessionId={scope.sessionId} sessions={[session()]} editor={testEditor}>
        <RuntimeUiPanelSurface />
      </RuntimeUiHost>,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Close denied-app" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The application must remain open.");
    expect(
      screen.getByRole("region", { name: "Runtime application denied-app" }),
    ).toBeInTheDocument();
  });

  it("does not show the destructive runtime-unavailable alert when there is no runtime bridge in this window", async () => {
    // window.runtimeUiAPI is only ever exposed by Electron's preload
    // contextBridge — it's undefined on the mobile web client. This must not
    // surface as a recurring "Runtime content could not be updated" alert
    // with an inactionable Reload button every time the client opens.
    window.runtimeUiAPI = undefined;
    render(
      <RuntimeUiHost activeSessionId={scope.sessionId} sessions={[session()]} editor={testEditor}>
        <RuntimeUiPanelSurface />
      </RuntimeUiHost>,
    );

    // Wait for the mount effect to actually settle (status moves off
    // "loading") before asserting the alert never appeared — otherwise this
    // assertion could pass by coincidence, before the effect has even run.
    await screen.findByText("No runtime panel content.");
    expect(screen.queryByTestId("runtime-ui-error")).toBeNull();
    expect(screen.queryByText("Runtime content could not be updated")).toBeNull();

    // Restore a working bridge — other tests in this file rely on
    // window.runtimeUiAPI carrying over a valid value between tests.
    window.runtimeUiAPI = createRuntimeUiApi(snapshot([])).api;
  });

  it("renders application state directly as text rather than executable markup", () => {
    const target = instance("inline-card", "inspector-app", {
      content: applicationContent(),
    });
    render(<RuntimeUiRenderer instance={target} editor={testEditor} />);

    expect(screen.queryByText(/alert\('unsafe'\)/, { selector: "script" })).toBeNull();
    expect(screen.queryByTitle("unsafe-frame")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("runtime-ui-state-inspector")).toHaveTextContent(
      "\\u003cscript\\u003e",
    );
  });
});
