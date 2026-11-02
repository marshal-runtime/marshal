import type { RuntimeUiAPI } from "@common/marshal-ipc-contract";
import { isVoiceTranscriptionAvailable } from "@common/runtime-config";
import {
  RUNTIME_UI_HOST_PLACEMENTS,
  type RuntimeUiPlacementApplication,
  type RuntimeUiPlacementDiagnostic,
  type RuntimeUiPlacementSnapshot,
} from "@common/runtime-ui";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeUiPlacementsProvider } from "@/features/runtime-ui/RuntimeUiPlacements";
import { installMockAPIs, render, screen, userEvent, waitFor } from "@/test-utils";

import { ChatInputAddOns } from "./ChatInputAddOns";

vi.mock("@common/runtime-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@common/runtime-config")>();
  return {
    ...actual,
    isVoiceTranscriptionAvailable: vi.fn<typeof actual.isVoiceTranscriptionAvailable>(
      actual.isVoiceTranscriptionAvailable,
    ),
  };
});
vi.mock("./MicButton", () => ({
  MicButton: () => <button type="button" data-testid="mic-btn" aria-label="Record voice message" />,
}));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null, ModelSelectionLabel: () => null }));
vi.mock("./ReasoningEffortPicker", () => ({ ReasoningEffortPicker: () => null }));
vi.mock("./WorkspaceRolePicker", () => ({ WorkspaceRolePicker: () => null }));

const ADD_CONTENT_KEY = "chat.composer.add";

function application(mode: RuntimeUiPlacementApplication["action"]): RuntimeUiPlacementApplication {
  return {
    extensionId: mode === "augment" ? "@fixture/overlay-review" : "@fixture/replacement",
    applicationId: mode === "augment" ? "overlay-review" : "replacement",
    title: mode === "augment" ? "Review on screen" : "Open replacement",
    description: "Fixture application",
    renderId: "fixture",
    action: mode,
    ...(mode === "replace" ? { replacement: "full" as const } : {}),
  };
}

function snapshot(options?: {
  readonly applications?: readonly RuntimeUiPlacementApplication[];
  readonly diagnostics?: readonly RuntimeUiPlacementDiagnostic[];
}): RuntimeUiPlacementSnapshot {
  return {
    revision: 1,
    generatedAt: "2026-08-16T10:00:00.000Z",
    placements: RUNTIME_UI_HOST_PLACEMENTS.map((metadata) =>
      metadata.key === ADD_CONTENT_KEY
        ? {
            metadata,
            applications: options?.applications ?? [],
          }
        : { metadata, applications: [] },
    ),
    diagnostics: options?.diagnostics ?? [],
  };
}

function runtimeUiApi(current: RuntimeUiPlacementSnapshot) {
  const activatePlacement = vi.fn<RuntimeUiAPI["activatePlacement"]>().mockResolvedValue({
    success: true,
    value: {
      receipt: {
        receiptId: "receipt-1",
        action: "open",
        status: "applied",
        completedAt: "2026-08-16T10:00:00.000Z",
        revision: 1,
      },
    },
  });
  const api: RuntimeUiAPI = {
    getSnapshot: vi.fn<RuntimeUiAPI["getSnapshot"]>(),
    subscribe: vi.fn<RuntimeUiAPI["subscribe"]>(),
    unsubscribe: vi.fn<RuntimeUiAPI["unsubscribe"]>(),
    open: vi.fn<RuntimeUiAPI["open"]>(),
    update: vi.fn<RuntimeUiAPI["update"]>(),
    focus: vi.fn<RuntimeUiAPI["focus"]>(),
    close: vi.fn<RuntimeUiAPI["close"]>(),
    list: vi.fn<RuntimeUiAPI["list"]>(),
    getPlacements: vi.fn<RuntimeUiAPI["getPlacements"]>().mockResolvedValue(current),
    activatePlacement,
    onEvent: vi.fn<RuntimeUiAPI["onEvent"]>().mockReturnValue(() => {}),
  };
  return { api, activatePlacement };
}

function renderAddOns(current: RuntimeUiPlacementSnapshot) {
  const runtime = runtimeUiApi(current);
  window.runtimeUiAPI = runtime.api;
  const onPickFile = vi.fn<() => void>();
  render(
    <RuntimeUiPlacementsProvider scope={{ sessionId: "session-1", workspaceName: "Workspace One" }}>
      <ChatInputAddOns
        sessionId="session-1"
        workspaceName="Workspace One"
        sdkReady
        hasUserMessages={false}
        onPickFile={onPickFile}
        onTranscript={() => {}}
      />
    </RuntimeUiPlacementsProvider>,
  );
  return { ...runtime, onPickFile };
}

describe("ChatInputAddOns runtime UI placements", () => {
  beforeEach(() => {
    installMockAPIs();
    vi.mocked(isVoiceTranscriptionAvailable).mockReturnValue(false);
  });

  it("keeps the default plus button as direct file upload without an extension", async () => {
    const { activatePlacement, onPickFile } = renderAddOns(snapshot());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Upload file" }));

    expect(onPickFile).toHaveBeenCalledOnce();
    expect(activatePlacement).not.toHaveBeenCalled();
    expect(screen.queryByText("Review on screen")).toBeNull();
  });

  it("renders the installed overlay-review augmentation as a context menu action", async () => {
    const overlay = application("augment");
    const { activatePlacement, onPickFile } = renderAddOns(snapshot({ applications: [overlay] }));
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Add content" }));
    expect(screen.getByRole("button", { name: "Upload file" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Review on screen" })).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Review on screen" }));
    await waitFor(() =>
      expect(activatePlacement).toHaveBeenCalledWith({
        sessionId: "session-1",
        workspaceName: "Workspace One",
        extensionId: overlay.extensionId,
        applicationId: overlay.applicationId,
        idempotencyKey: expect.stringMatching(
          /^placement-@fixture\/overlay-review-overlay-review-/,
        ),
      }),
    );
    expect(onPickFile).not.toHaveBeenCalled();
  });

  it("shows red conflict diagnostics and deterministically restores file upload", async () => {
    const diagnostic: RuntimeUiPlacementDiagnostic = {
      id: "exact-target-collision:chat.composer.add",
      code: "exact-target-collision",
      severity: "error",
      message:
        'UI placement "chat.composer.add" has multiple registrations for target "chat.composer.add"; Marshal restored the default component for the conflicting targets.',
      repairHint: "Keep only one replacement.",
      placementId: ADD_CONTENT_KEY,
      targets: [ADD_CONTENT_KEY],
      extensionIds: ["@fixture/one", "@fixture/two"],
      registrationIds: ["one", "two"],
    };
    const { onPickFile } = renderAddOns(snapshot({ diagnostics: [diagnostic] }));
    const user = userEvent.setup();

    const alert = await screen.findByTestId("runtime-ui-placement-diagnostics");
    expect(alert.classList.contains("text-destructive")).toBe(true);
    expect(alert.textContent).toContain("Marshal restored the default component");
    await user.click(screen.getByRole("button", { name: "Upload file" }));
    expect(onPickFile).toHaveBeenCalledOnce();
  });

  it("allows one extension to fully replace the host add-content component", async () => {
    const replacement = application("replace");
    const { activatePlacement, onPickFile } = renderAddOns(
      snapshot({ applications: [replacement] }),
    );
    const user = userEvent.setup();

    await screen.findByRole("button", { name: "Open replacement" });
    expect(screen.queryByRole("button", { name: "Upload file" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open replacement" }));

    await waitFor(() =>
      expect(activatePlacement).toHaveBeenCalledWith({
        sessionId: "session-1",
        workspaceName: "Workspace One",
        extensionId: replacement.extensionId,
        applicationId: replacement.applicationId,
        idempotencyKey: expect.stringMatching(/^placement-@fixture\/replacement-replacement-/),
      }),
    );
    expect(onPickFile).not.toHaveBeenCalled();
  });

  it("hides the microphone while Cursor SDK transcription is unavailable", () => {
    renderAddOns(snapshot());
    expect(screen.queryByTestId("mic-btn")).toBeNull();
  });

  it("shows the microphone when Cursor SDK transcription is available", async () => {
    vi.mocked(isVoiceTranscriptionAvailable).mockReturnValue(true);
    renderAddOns(snapshot());
    expect(await screen.findByTestId("mic-btn")).not.toBeNull();
  });
});
