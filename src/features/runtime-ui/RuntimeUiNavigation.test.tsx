import type { CommandCenterAPI, RuntimeUiAPI, SessionMetadata } from "@common/marshal-ipc-contract";
import {
  RUNTIME_UI_HOST_PLACEMENTS,
  RUNTIME_UI_USER_SCOPE,
  type RuntimeUiEvent,
  type RuntimeUiInstance,
  type RuntimeUiScope,
} from "@common/runtime-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent, waitFor } from "@/test-utils";

import { testDouble } from "../../../electron/testing/harness";
import { registerRuntimeUiApplicationRenderer } from "./RuntimeUiApplicationRegistry";
import { RuntimeUiHost } from "./RuntimeUiHost";
import {
  RuntimeUiApplicationWorkspace,
  RuntimeUiNavigationEntries,
  useRuntimeUiNavigation,
} from "./RuntimeUiNavigation";

const application = {
  extensionId: "fixture.nav",
  applicationId: "notes",
  title: "Notes",
  description: "Notes application",
  renderId: "fixture.notes",
  action: "augment" as const,
};
const instance: RuntimeUiInstance = {
  instanceId: "navigation-notes",
  owner: {
    ...RUNTIME_UI_USER_SCOPE,
    extensionId: application.extensionId,
    applicationId: application.applicationId,
  },
  surface: "tab",
  content: {
    kind: "application",
    renderId: application.renderId,
    resource: { uri: "ui://fixture/notes", mimeType: "text/html" },
    descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
  },
  idempotencyKey: "open-notes",
  revision: 1,
  openedAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  focusedAt: "2026-09-09T00:00:00.000Z",
};

function DismissButton() {
  const navigation = useRuntimeUiNavigation();
  return <button onClick={() => navigation?.dismiss()}>Show chat</button>;
}

const eventListeners = new Set<(event: import("@common/runtime-ui").RuntimeUiEvent) => void>();

function fixture() {
  let opened = false;
  eventListeners.clear();
  const snapshot = (scope: RuntimeUiScope) => ({
    success: true as const,
    value: {
      revision: opened ? 1 : 0,
      generatedAt: instance.openedAt,
      scope,
      instances: scope.applicationScope && opened ? [instance] : [],
      events: [],
    },
  });
  const api: Partial<RuntimeUiAPI> = {
    getSnapshot: vi.fn<RuntimeUiAPI["getSnapshot"]>(async (scope) => snapshot(scope)),
    subscribe: vi.fn<RuntimeUiAPI["subscribe"]>(async (scope) => snapshot(scope)),
    unsubscribe: vi.fn<RuntimeUiAPI["unsubscribe"]>(async () => ({ success: true })),
    onEvent: vi.fn<RuntimeUiAPI["onEvent"]>((listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    }),
    getPlacements: vi.fn<RuntimeUiAPI["getPlacements"]>(async () => ({
      revision: 1,
      generatedAt: instance.openedAt,
      diagnostics: [],
      placements: RUNTIME_UI_HOST_PLACEMENTS.map((metadata) => ({
        metadata,
        applications: metadata.id === "nav.primary" ? [application] : [],
      })),
    })),
    activatePlacement: vi.fn<RuntimeUiAPI["activatePlacement"]>(async () => {
      opened = true;
      return {
        success: true,
        value: {
          receipt: {
            receiptId: "receipt",
            action: "open",
            status: "applied",
            completedAt: instance.openedAt,
            revision: 1,
          },
          instance,
        },
      };
    }),
    invokeCapability: vi.fn<NonNullable<RuntimeUiAPI["invokeCapability"]>>(async () => ({
      success: true,
      value: { output: null },
    })),
    readResource: vi.fn<NonNullable<RuntimeUiAPI["readResource"]>>(async () => ({
      success: true,
      value: { uri: "ui://fixture/notes", mimeType: "text/html", text: "" },
    })),
  };
  installMockAPIs();
  window.runtimeUiAPI = testDouble<RuntimeUiAPI>(api);
  return api;
}

const view = registerRuntimeUiApplicationRenderer(application.renderId, () => (
  <textarea aria-label="Application notes" defaultValue="" />
));
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});

describe("RuntimeUiNavigation", () => {
  it("opens without a chat and keeps the application mounted while chats change or its view is hidden", async () => {
    const api = fixture();
    const user = userEvent.setup();
    const editor = { id: "test", SourceEditor: () => null };
    const sessions: SessionMetadata[] = [
      {
        id: "chat-1",
        name: "Chat",
        createdAt: instance.openedAt,
        updatedAt: instance.openedAt,
        hasUnread: false,
        isActive: true,
      },
    ];
    const ui = (activeSessionId: string | null) => (
      <RuntimeUiHost activeSessionId={activeSessionId} sessions={sessions} editor={editor}>
        <RuntimeUiNavigationEntries />
        <DismissButton />
        <RuntimeUiApplicationWorkspace>
          <p>Chat workspace</p>
        </RuntimeUiApplicationWorkspace>
      </RuntimeUiHost>
    );
    const utils = render(ui(null));
    await user.click(await screen.findByRole("button", { name: "Notes" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Application notes" })).toBeVisible(),
    );
    expect(api.activatePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ applicationScope: "user", placementId: "nav.primary" }),
    );
    expect(vi.mocked(api.activatePlacement!).mock.calls[0][0]).not.toHaveProperty("sessionId");
    await user.type(screen.getByRole("textbox", { name: "Application notes" }), "Retained draft");
    const input = screen.getByRole("textbox", { name: "Application notes" });
    utils.rerender(ui("chat-1"));
    expect(screen.getByRole("textbox", { name: "Application notes" })).toBe(input);
    await user.click(screen.getByRole("button", { name: "Show chat" }));
    expect(input).not.toBeVisible();
    expect(screen.getByText("Chat workspace")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Notes" }));
    await waitFor(() => expect(input).toBeVisible());
    expect(input).toHaveValue("Retained draft");
    utils.unmount();
    expect(api.unsubscribe).toHaveBeenCalledWith(RUNTIME_UI_USER_SCOPE);
    view();
  });

  it("does not hijack the desktop pane when the phone activates the app (M2)", async () => {
    fixture();
    // The previous test disposed the module-level renderer registration.
    disposers.push(
      registerRuntimeUiApplicationRenderer(application.renderId, () => (
        <textarea aria-label="Application notes" defaultValue="" />
      )),
    );
    const editor = { id: "test", SourceEditor: () => null };
    render(
      <RuntimeUiHost activeSessionId={null} sessions={[]} editor={editor}>
        <RuntimeUiNavigationEntries />
        <RuntimeUiApplicationWorkspace>
          <p>Chat workspace</p>
        </RuntimeUiApplicationWorkspace>
      </RuntimeUiHost>,
    );
    await screen.findByRole("button", { name: "Notes" });
    expect(screen.getByText("Chat workspace")).toBeVisible();
    // A phone activation reaches the desktop as an instance event whose focus
    // originated remotely. The desktop keeps its current view.
    const remoteOpened: RuntimeUiEvent = {
      type: "instance-opened",
      sequence: 5,
      occurredAt: instance.openedAt,
      scope: RUNTIME_UI_USER_SCOPE,
      instance: { ...instance, revision: 5, focusedBy: "remote" as const },
    };
    for (const listener of eventListeners) listener(remoteOpened);
    // The instance mounts (hidden) in the workspace, but the desktop keeps the
    // chat view: role queries skip hidden subtrees, so query by label.
    await waitFor(() =>
      expect(document.querySelector('[aria-label="Application notes"]')).not.toBeNull(),
    );
    expect(document.querySelector('[aria-label="Application notes"]')).not.toBeVisible();
    expect(screen.getByText("Chat workspace")).toBeVisible();
    // A desktop-originated focus of the same instance still auto-selects.
    const desktopFocused: RuntimeUiEvent = {
      type: "instance-focused",
      sequence: 6,
      occurredAt: "2026-09-13T09:00:00.000Z",
      scope: RUNTIME_UI_USER_SCOPE,
      instance: {
        ...instance,
        revision: 6,
        focusedAt: "2026-09-13T09:00:00.000Z",
        focusedBy: "desktop" as const,
      },
    };
    for (const listener of eventListeners) listener(desktopFocused);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Application notes" })).toBeVisible(),
    );
  });

  it("shows the chat after the application opens a session", async () => {
    const openSession = await openSessionFromApplication({ success: true });

    expect(openSession).toHaveBeenCalledWith(OPENED_SESSION_ID);
    await waitFor(() => expect(screen.getByText("Chat workspace")).toBeVisible());
  });

  it("keeps the application when the session cannot be opened", async () => {
    const openSession = await openSessionFromApplication({
      success: false,
      error: "Session not found",
    });

    expect(openSession).toHaveBeenCalledWith(OPENED_SESSION_ID);
    expect(screen.getByText("Chat workspace")).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Open chat" })).toBeVisible();
  });
});

const OPENED_SESSION_ID = "opened-chat";

async function openSessionFromApplication(
  result: Awaited<ReturnType<CommandCenterAPI["openSession"]>>,
) {
  fixture();
  const openSession = vi.fn<CommandCenterAPI["openSession"]>(async () => result);
  window.commandCenterAPI = testDouble<CommandCenterAPI>({ openSession });
  const user = userEvent.setup();
  let settled: Promise<void> = Promise.resolve();
  disposers.push(
    registerRuntimeUiApplicationRenderer(application.renderId, ({ host }) => (
      <button
        type="button"
        onClick={() => {
          settled = (host.openSession?.(OPENED_SESSION_ID) ?? Promise.resolve()).catch(() => {});
        }}
      >
        Open chat
      </button>
    )),
  );
  render(
    <RuntimeUiHost
      activeSessionId={null}
      sessions={[]}
      editor={{ id: "test", SourceEditor: () => null }}
    >
      <RuntimeUiNavigationEntries />
      <RuntimeUiApplicationWorkspace>
        <p>Chat workspace</p>
      </RuntimeUiApplicationWorkspace>
    </RuntimeUiHost>,
  );
  await user.click(await screen.findByRole("button", { name: "Notes" }));
  await user.click(await screen.findByRole("button", { name: "Open chat" }));
  await settled;
  return openSession;
}
