import type { RuntimeUiAPI, SessionMetadata } from "@common/marshal-ipc-contract";
import type { RuntimeUiInstance } from "@common/runtime-ui";
import { use } from "react";
import { expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent, waitFor } from "@/test-utils";

import { testDouble } from "../../../electron/testing/harness";
import {
  RuntimeUiSelectedSessionContext,
  RuntimeUiSessionPickerContext,
  RuntimeUiSessionSelection,
  RuntimeUiSessionsContext,
} from "./RuntimeUiSessionSelection";

function SelectedGrant() {
  const selection = use(RuntimeUiSelectedSessionContext);
  return <output data-testid="selection-grant">{selection?.grantId ?? "unselected"}</output>;
}

// Stands in for the application renderer: descendants summon the picker on the
// app's behalf (ui/requestSessionSelection / a grant-required failure).
function PickerControls() {
  const picker = use(RuntimeUiSessionPickerContext);
  return (
    <>
      <button type="button" onClick={() => picker?.summon()}>
        summon picker
      </button>
      <button type="button" onClick={() => picker?.dismiss()}>
        dismiss picker
      </button>
    </>
  );
}

const timestamp = "2026-09-09T00:00:00.000Z";

function fixture() {
  installMockAPIs();
  const selectSession = vi.fn<NonNullable<RuntimeUiAPI["selectSession"]>>(async (request) => ({
    success: true,
    value: request.targetSessionId
      ? { grantId: "granted-by-host", sessionId: request.targetSessionId, title: "Driving session" }
      : null,
  }));
  window.runtimeUiAPI = testDouble<RuntimeUiAPI>({
    getSelectedSession: vi.fn<NonNullable<RuntimeUiAPI["getSelectedSession"]>>(async () => ({
      success: true,
      value: null,
    })),
    selectSession,
  });
  const instance: RuntimeUiInstance = {
    instanceId: "app",
    owner: {
      applicationScope: "workspace",
      workspaceName: "project",
      extensionId: "fixture",
      applicationId: "review",
    },
    surface: "tab",
    content: {
      kind: "application",
      renderId: "fixture.review",
      resource: { uri: "ui://fixture/review", mimeType: "text/html" },
      descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
    },
    revision: 1,
    idempotencyKey: "open",
    openedAt: timestamp,
    updatedAt: timestamp,
    focusedAt: timestamp,
  };
  const sessions: SessionMetadata[] = [
    {
      id: "target",
      name: "Driving session",
      workspaceName: "project",
      createdAt: timestamp,
      updatedAt: timestamp,
      hasUnread: false,
      isActive: false,
    },
    {
      id: "other",
      name: "Foreign session",
      workspaceName: "other-project",
      createdAt: timestamp,
      updatedAt: timestamp,
      hasUnread: false,
      isActive: false,
    },
  ];
  render(
    <RuntimeUiSessionsContext value={sessions}>
      <RuntimeUiSessionSelection instance={instance}>
        <SelectedGrant />
        <PickerControls />
      </RuntimeUiSessionSelection>
    </RuntimeUiSessionsContext>,
  );
  return { instance, selectSession, user: userEvent.setup() };
}

it("OMR2-1: keeps the assistant-session picker hidden until summoned, and dismissible without a selection", async () => {
  const { selectSession, user } = fixture();
  // Not permanent chrome: no strip and no picker until something summons it.
  expect(screen.queryByRole("combobox", { name: "Assistant session" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "summon picker" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Assistant session" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "dismiss picker" }));
  await waitFor(() =>
    expect(screen.queryByRole("combobox", { name: "Assistant session" })).toBeNull(),
  );
  // Summoning and dismissing the picker is pure visibility — nothing was selected.
  expect(selectSession).not.toHaveBeenCalled();
});

it("§7 regression guard: a session grant is still minted only by a user-performed selection in the visible picker", async () => {
  const { instance, selectSession, user } = fixture();
  await user.click(screen.getByRole("button", { name: "summon picker" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Assistant session" })).toBeEnabled(),
  );
  // The summon alone must not mint anything (§7: fresh, visible, user-performed).
  expect(selectSession).not.toHaveBeenCalled();
  await user.click(screen.getByRole("combobox", { name: "Assistant session" }));
  await user.click(screen.getByRole("option", { name: "Driving session" }));
  await waitFor(() =>
    expect(screen.getByTestId("selection-grant")).toHaveTextContent("granted-by-host"),
  );
  expect(selectSession).toHaveBeenCalledTimes(1);
  expect(selectSession).toHaveBeenCalledWith({
    ...instance.owner,
    instanceId: instance.instanceId,
    targetSessionId: "target",
  });
  // On-demand chrome: the strip retires after the grant, the grant persists.
  await waitFor(() =>
    expect(screen.queryByRole("combobox", { name: "Assistant session" })).toBeNull(),
  );
  expect(screen.getByTestId("selection-grant")).toHaveTextContent("granted-by-host");
});

it("limits native selection to the workspace, exposes the granted identity and clears it", async () => {
  const { instance, selectSession, user } = fixture();
  await user.click(screen.getByRole("button", { name: "summon picker" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Assistant session" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("combobox", { name: "Assistant session" }));
  expect(screen.queryByRole("option", { name: "Foreign session" })).toBeNull();
  await user.click(screen.getByRole("option", { name: "Driving session" }));
  await waitFor(() =>
    expect(screen.getByTestId("selection-grant")).toHaveTextContent("granted-by-host"),
  );
  expect(selectSession).toHaveBeenCalledWith({
    ...instance.owner,
    instanceId: instance.instanceId,
    targetSessionId: "target",
  });
  await user.click(screen.getByRole("button", { name: "summon picker" }));
  await user.click(screen.getByRole("combobox", { name: "Assistant session" }));
  await user.click(screen.getByRole("option", { name: "No session selected" }));
  await waitFor(() =>
    expect(screen.getByTestId("selection-grant")).toHaveTextContent("unselected"),
  );
  expect(selectSession).toHaveBeenLastCalledWith({
    ...instance.owner,
    instanceId: instance.instanceId,
  });
});
