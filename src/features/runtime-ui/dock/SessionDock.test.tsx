import type { RuntimeUiAPI } from "@common/marshal-ipc-contract";
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

// The side and bottom docks always exist; while hidden and empty they keep their own watermark.
const HIDDEN_EDGE_DOCKS = 2;

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
