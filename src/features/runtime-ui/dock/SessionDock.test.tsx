import type { RuntimeUiAPI } from "@common/marshal-ipc-contract";
import type { RuntimeUiJsonValue } from "@common/runtime-ui";
import type { RuntimeUiDesktopLayout } from "@common/runtime-ui-layout";
import { act } from "react";
import { expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, waitFor } from "@/test-utils";

import { testDouble } from "../../../../electron/testing/harness";
import { RuntimeUiContext } from "../runtimeUiContext";
import type { RuntimeUiModel } from "../useRuntimeUi";
import { SessionDock } from "./SessionDock";

vi.mock("../cards/ConversationCards", () => ({ RuntimeUiTransientCards: () => null }));

// A layout saved with an empty group to the left of the chat, as older builds could save it.
const LAYOUT_WITH_EMPTY_GROUP: RuntimeUiDesktopLayout = {
  version: 1,
  savedAt: "2026-11-22T00:00:00.000Z",
  summary: {
    placements: [],
    side: { visible: false },
    bottom: { visible: false },
    floating: [],
    window: { width: 1000, height: 800 },
  },
  dockview: {
    grid: {
      root: {
        type: "branch",
        data: [
          { type: "leaf", data: { views: [], id: "empty" }, size: 400 },
          {
            type: "leaf",
            data: { views: ["marshal.chat"], activeView: "marshal.chat", id: "chat" },
            size: 600,
          },
        ],
        size: 800,
      },
      width: 1000,
      height: 800,
      orientation: "HORIZONTAL",
    },
    panels: { "marshal.chat": { id: "marshal.chat", contentComponent: "chat", title: "Chat" } },
    activeGroup: "chat",
  },
};

// The layout saved on 2026-11-22: Chat inside the side dock and nothing left in the center grid.
const LAYOUT_WITH_CHAT_IN_SIDE_DOCK: RuntimeUiDesktopLayout = {
  version: 1,
  savedAt: "2026-11-22T19:42:22.768Z",
  summary: {
    placements: [],
    side: { visible: true, size: 1477 },
    bottom: { visible: false },
    floating: [],
    window: { width: 2133, height: 1112 },
  },
  dockview: {
    grid: {
      root: { type: "branch", data: [], size: 1065 },
      width: 320,
      height: 1065,
      orientation: "HORIZONTAL",
    },
    panels: {
      "marshal.chat": { id: "marshal.chat", contentComponent: "chat", title: "Chat" },
      "marshal.progress": {
        id: "marshal.progress",
        contentComponent: "progress",
        title: "Progress",
      },
    },
    activeGroup: "marshal.side",
    edgeGroups: {
      right: {
        size: 1477,
        visible: true,
        minimumSize: 220,
        maximumSize: 100_000,
        collapsedSize: 35,
        group: {
          views: ["marshal.chat", "marshal.progress"],
          activeView: "marshal.chat",
          id: "marshal.side",
        },
      },
      bottom: {
        size: 300,
        visible: false,
        minimumSize: 120,
        maximumSize: 100_000,
        collapsedSize: 35,
        group: { views: [], id: "marshal.bottom" },
      },
    },
  },
};

// The side and bottom docks always exist; while hidden and empty they keep their own watermark.
const HIDDEN_EDGE_DOCKS = 2;

function isJsonObject(
  value: RuntimeUiJsonValue | undefined,
): value is { readonly [key: string]: RuntimeUiJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function member(value: RuntimeUiJsonValue | undefined, key: string) {
  return isJsonObject(value) ? value[key] : undefined;
}

function holdsChat(views: RuntimeUiJsonValue | undefined): boolean {
  return Array.isArray(views) && views.includes("marshal.chat");
}

/** The view lists of every leaf group under a saved grid node. */
function leafViews(node: RuntimeUiJsonValue | undefined): (RuntimeUiJsonValue | undefined)[] {
  const data = member(node, "data");
  return Array.isArray(data) ? data.flatMap(leafViews) : [member(data, "views")];
}

/** Where the chat tab sits in a layout sent to saveLayout. */
function chatLocation(saved: Parameters<NonNullable<RuntimeUiAPI["saveLayout"]>>[0]) {
  const { dockview } = saved.layout;
  const edgeGroups = dockview.edgeGroups;
  return {
    inGrid: leafViews(member(dockview.grid, "root")).some(holdsChat),
    edges: ["right", "bottom"].filter((position) =>
      holdsChat(member(member(member(edgeGroups, position), "group"), "views")),
    ),
  };
}

function emptyModel(sessionId: string) {
  return testDouble<RuntimeUiModel>({
    scope: { sessionId, workspaceName: "workspace" },
    instances: [],
    bySurface: { tab: [], fullscreen: [], panel: [], "bottom-panel": [], floating: [] },
  });
}

it("drops empty groups so the chat is the only tab, in the thread and in the next new chat", async () => {
  installMockAPIs();
  const getLayout = vi.fn<NonNullable<RuntimeUiAPI["getLayout"]>>(async (scope) => ({
    success: true,
    value: scope.sessionId === "existing" ? { scope, desktop: LAYOUT_WITH_EMPTY_GROUP } : { scope },
  }));
  window.runtimeUiAPI = testDouble<RuntimeUiAPI>({
    getLayout,
    saveLayout: vi.fn<NonNullable<RuntimeUiAPI["saveLayout"]>>(async () => ({
      success: true,
      value: null,
    })),
  });
  const dock = (sessionId: string) => (
    <RuntimeUiContext value={emptyModel(sessionId)}>
      <SessionDock chat={<p>Conversation</p>} renderProgress={() => null} />
    </RuntimeUiContext>
  );
  const view = render(dock("existing"));
  await waitFor(() => expect(getLayout).toHaveBeenCalledOnce());
  await act(() => getLayout.mock.results[0]?.value);
  expect(screen.getByText("Conversation")).toBeInTheDocument();
  expect(screen.queryAllByText("Drop a tab here")).toHaveLength(HIDDEN_EDGE_DOCKS);

  view.rerender(dock("new-chat"));
  await waitFor(() => expect(getLayout).toHaveBeenCalledTimes(2));
  await act(() => getLayout.mock.results[1]?.value);
  expect(screen.getByText("Conversation")).toBeInTheDocument();
  expect(screen.queryAllByText("Drop a tab here")).toHaveLength(HIDDEN_EDGE_DOCKS);
});

it("keeps the chat attached while runtime layout authorization is pending", async () => {
  installMockAPIs();
  let finish!: (value: Awaited<ReturnType<NonNullable<RuntimeUiAPI["getLayout"]>>>) => void;
  const getLayout = vi.fn<NonNullable<RuntimeUiAPI["getLayout"]>>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const saveLayout = vi.fn<NonNullable<RuntimeUiAPI["saveLayout"]>>(async () => ({
    success: true,
    value: null,
  }));
  window.runtimeUiAPI = testDouble<RuntimeUiAPI>({ getLayout, saveLayout });
  const scope = { sessionId: "retained-chat", workspaceName: "workspace" };
  const model = testDouble<RuntimeUiModel>({
    scope,
    instances: [],
    bySurface: { tab: [], fullscreen: [], panel: [], "bottom-panel": [], floating: [] },
  });
  render(
    <RuntimeUiContext value={model}>
      <SessionDock chat={<p>Retained conversation</p>} renderProgress={() => null} />
    </RuntimeUiContext>,
  );
  await waitFor(() => expect(getLayout).toHaveBeenCalledOnce());
  const attachedChat = screen.getByTestId("session-dock-chat");
  expect(screen.getByTestId("session-dock-chat")).toContainElement(
    screen.getByText("Retained conversation"),
  );
  expect(saveLayout).not.toHaveBeenCalled();
  await act(async () => finish({ success: true, value: { scope } }));
  expect(screen.getByTestId("session-dock-chat")).toBe(attachedChat);
  expect(screen.getByTestId("session-dock-chat")).toContainElement(
    screen.getByText("Retained conversation"),
  );
});

function chatTabInSideDock(): boolean {
  const tab = document.querySelector(
    '[data-testid="session-dock-tab"][data-panel-id="marshal.chat"]',
  );
  expect(tab).not.toBeNull();
  return tab?.closest(".dv-groupview-edge") != null;
}

function layoutDock(layouts: Record<string, RuntimeUiDesktopLayout>) {
  installMockAPIs();
  const getLayout = vi.fn<NonNullable<RuntimeUiAPI["getLayout"]>>(async (scope) => {
    const desktop = scope.sessionId ? layouts[scope.sessionId] : undefined;
    return { success: true, value: desktop ? { scope, desktop } : { scope } };
  });
  const saveLayout = vi.fn<NonNullable<RuntimeUiAPI["saveLayout"]>>(async () => ({
    success: true,
    value: null,
  }));
  window.runtimeUiAPI = testDouble<RuntimeUiAPI>({ getLayout, saveLayout });
  const dock = (sessionId: string) => (
    <RuntimeUiContext value={emptyModel(sessionId)}>
      <SessionDock chat={<p>Conversation</p>} renderProgress={() => null} />
    </RuntimeUiContext>
  );
  const open = async (view: ReturnType<typeof render> | undefined, sessionId: string) => {
    const calls = getLayout.mock.calls.length;
    const rendered = view ?? render(dock(sessionId));
    if (view) view.rerender(dock(sessionId));
    await waitFor(() => expect(getLayout).toHaveBeenCalledTimes(calls + 1));
    await act(() => getLayout.mock.results[calls]?.value);
    return rendered;
  };
  return { open, saveLayout };
}

it("moves the chat out of the side dock a saved layout left it in, and saves the repair", async () => {
  const { open, saveLayout } = layoutDock({ existing: LAYOUT_WITH_CHAT_IN_SIDE_DOCK });
  const view = await open(undefined, "existing");
  expect(screen.getByText("Conversation")).toBeInTheDocument();
  expect(chatTabInSideDock()).toBe(false);
  await waitFor(() => expect(saveLayout).toHaveBeenCalled());
  const saved = saveLayout.mock.calls.at(-1)?.[0];
  expect(saved && chatLocation(saved)).toEqual({ inGrid: true, edges: [] });

  // The next new chat starts with the chat in the center too, instead of inheriting the side dock.
  await open(view, "new-chat");
  expect(screen.getByText("Conversation")).toBeInTheDocument();
  expect(chatTabInSideDock()).toBe(false);
});

it("adds the chat to the center grid even when the side dock is the active group", async () => {
  // No chat in the layout and no center group: dockview would add the chat to the active group.
  const withoutChat: RuntimeUiDesktopLayout = {
    ...LAYOUT_WITH_CHAT_IN_SIDE_DOCK,
    dockview: {
      ...LAYOUT_WITH_CHAT_IN_SIDE_DOCK.dockview,
      panels: {
        "marshal.progress": {
          id: "marshal.progress",
          contentComponent: "progress",
          title: "Progress",
        },
      },
      edgeGroups: {
        right: {
          size: 420,
          visible: true,
          minimumSize: 220,
          maximumSize: 100_000,
          collapsedSize: 35,
          group: {
            views: ["marshal.progress"],
            activeView: "marshal.progress",
            id: "marshal.side",
          },
        },
      },
    },
  };
  const { open } = layoutDock({ existing: withoutChat });
  await open(undefined, "existing");
  expect(screen.getByText("Conversation")).toBeInTheDocument();
  expect(chatTabInSideDock()).toBe(false);
});
