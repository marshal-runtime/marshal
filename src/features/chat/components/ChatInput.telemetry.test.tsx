import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TelemetryProvider } from "@/services/telemetry";
import {
  TelemetryPath_App,
  TelemetryPath_Chat,
  TelemetryPath_Input,
} from "@/services/telemetry/schema";
import { RenderScenarioProvider } from "@/services/telemetry/RenderScenarioProvider";
import {
  countUserActions,
  createCaptureSink,
  findUserAction,
  sinkSetup,
} from "@/services/telemetry/test-utils";
import { installMockAPIs, render, screen, waitFor, userEvent } from "@/test-utils";

import { pressInPromptEditor } from "../testing/prompt-editor-dom";
import { setPromptText } from "../testing/prompt-editor-ref";
import { ChatInput, type ChatInputRef } from "./ChatInput";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

const defaultProps = {
  sessionId: null as string | null,
  userMessages: [] as string[],
  isWaiting: false,
  sdkReady: true,
  initError: null,
  hasUserMessages: false,
  onSubmit: vi.fn<(text: string) => void>(),
  onStop: vi.fn<() => void>(),
};

function renderChatInput(overrides?: Partial<typeof defaultProps>) {
  const ref = createRef<ChatInputRef>();
  const view = render(
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">
        <TelemetryPath_App>
          <TelemetryPath_Chat>
            <TelemetryPath_Input>
              <ChatInput ref={ref} {...defaultProps} {...overrides} />
            </TelemetryPath_Input>
          </TelemetryPath_Chat>
        </TelemetryPath_App>
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
  return { ...view, ref };
}

describe("ChatInput telemetry", () => {
  beforeEach(() => {
    events.splice(0);
    installMockAPIs();
  });

  it("emits exactly one UserAction for Send at /App/Chat/Input when the button is clicked", async () => {
    const user = userEvent.setup();
    const { ref } = renderChatInput();
    await setPromptText(ref, "Hello world");
    await user.click(screen.getByTestId("send-btn"));
    await waitFor(() => {
      expect(findUserAction(events, "Send", "/App/Chat/Input")).toBeDefined();
    });
    // Defensive regression-pin for the Enter-key Send undercount: this change wraps the form's onSubmit
    // with the same Send measure as the button. In practice handleSubmit's
    // synchronous preventDefault on the click event prevents the form-submit
    // cascade from firing a second Send, but that's an implicit dependency.
    // We assert exactly one Send so a future change that drops preventDefault
    // or alters the submit-button semantics will fail this test.
    expect(countUserActions(events, "Send", "/App/Chat/Input")).toBe(1);
  });

  // Regression for the Enter-key Send undercount: prior to wrapping `handleSubmit` with
  // `useInteractiveElementMonitor_Send` at the form level, Enter-key submits
  // bypassed the Send measure entirely (only the button-click path was
  // instrumented), so `Send` undercounted real sends by ~80–95% in any chat
  // product where keyboard is the dominant submit path.
  it("emits exactly one UserAction for Send when submitted via Enter key", async () => {
    const { ref } = renderChatInput();
    await setPromptText(ref, "Hello via Enter");
    pressInPromptEditor("Enter");
    await waitFor(() => {
      expect(findUserAction(events, "Send", "/App/Chat/Input")).toBeDefined();
    });
    expect(countUserActions(events, "Send", "/App/Chat/Input")).toBe(1);
  });

  // Regression for the inverse of the Enter-key Send undercount: without
  // a `!canSubmit` guard, the Lexical Enter handler would route through
  // `instrumentedSubmit`, which emits the `Send` UserAction *before* invoking
  // `handleSubmit` (the wrapper's `interactionDisabled` only affects the
  // Render checkpoint, not UserAction emission — see
  // the telemetry interaction wrapper).
  // Result: pressing Enter on an empty editor would fire a phantom `Send`
  // even though no message is actually sent, distorting the very same
  // active-sender funnel that the Send measure is meant to clean up.
  it("does NOT emit Send when Enter is pressed on an empty editor", async () => {
    renderChatInput();
    pressInPromptEditor("Enter");
    // Flush microtasks so any (mis)fired UserAction would have been captured.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(countUserActions(events, "Send", "/App/Chat/Input")).toBe(0);
  });

  // Same inverse-undercount guard, but for the `!sdkReady` branch: with content
  // typed but the SDK not yet ready, `handleSubmit` still no-ops at its
  // validation guard. Without `!canSubmit` gating `handleEditorEnter`, this
  // would fire a phantom `Send`.
  it("does NOT emit Send when Enter is pressed while SDK is not ready", async () => {
    const { ref } = renderChatInput({ sdkReady: false });
    await setPromptText(ref, "Typed but SDK not ready");
    pressInPromptEditor("Enter");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(countUserActions(events, "Send", "/App/Chat/Input")).toBe(0);
  });

  // End-to-end pin: with a real `sessionId`, the wrapped `instrumentedSubmit`
  // both emits `Send` AND invokes `onSubmit`. The other Send tests in this
  // file use `sessionId: null` (the default), so `handleSubmit` short-circuits
  // at its `!sessionId` guard — they pin the monitor hook only, not the
  // end-to-end submit pipeline. This test closes that gap so a future change
  // that breaks the submit pipeline without touching the telemetry wiring
  // fails here. Raised in review.
  it("invokes onSubmit exactly once and emits exactly one Send when Enter is pressed with a sessionId", async () => {
    const onSubmit = vi.fn<(text: string) => void>();
    const { ref } = renderChatInput({ sessionId: "test-session", onSubmit });
    await setPromptText(ref, "End-to-end Enter submit");
    pressInPromptEditor("Enter");
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0]?.[0]).toBe("End-to-end Enter submit");
    expect(countUserActions(events, "Send", "/App/Chat/Input")).toBe(1);
  });

  it("emits UserAction for Stop at /App/Chat/Input", async () => {
    const user = userEvent.setup();
    renderChatInput({ isWaiting: true });
    await user.click(screen.getByTestId("stop-btn"));
    await waitFor(() => {
      expect(findUserAction(events, "Stop", "/App/Chat/Input")).toBeDefined();
    });
  });
});
