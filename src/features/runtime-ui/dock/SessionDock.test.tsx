import type { RuntimeUiAPI } from "@common/marshal-ipc-contract";
import { act } from "react";
import { expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, waitFor } from "@/test-utils";

import { testDouble } from "../../../../electron/testing/harness";
import { RuntimeUiContext } from "../runtimeUiContext";
import type { RuntimeUiModel } from "../useRuntimeUi";
import { SessionDock } from "./SessionDock";

vi.mock("../cards/ConversationCards", () => ({ RuntimeUiTransientCards: () => null }));

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
