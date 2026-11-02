import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TelemetryAPI } from "../../../common/marshal-ipc-contract";
import { render } from "../../test-utils";
import { TelemetryProvider } from "./index";
import { RenderScenarioProvider } from "./RenderScenarioProvider";

let capturedLogEventCallback:
  | ((event: { scenario: string; fields: Record<string, unknown> }) => void)
  | null = null;
const mockUnsubscribe = vi.fn<() => void>();
const mockLogFetchEvent = vi.fn<(fields: Record<string, unknown>) => void>();

vi.mock("./opensource", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./opensource")>();
  return {
    ...actual,
    useTelemetry: () => ({
      telemetryCallbacks: {
        ...actual.emptyTelemetry.telemetryCallbacks,
        logFetchEvent: mockLogFetchEvent,
      },
      telemetryContextProps: {
        ...actual.emptyTelemetryContextProps,
        getSessionCorrelationId: () => "test-session-correlation",
        getUserId: () => "test-user",
        getTenantId: () => "test-tenant",
      },
    }),
  };
});

beforeEach(() => {
  capturedLogEventCallback = null;
  mockUnsubscribe.mockReset();
  mockLogFetchEvent.mockReset();
  window.telemetryAPI = {
    writeLocalEvent: vi.fn<TelemetryAPI["writeLocalEvent"]>().mockResolvedValue({ success: true }),
    deleteLocalData: vi.fn<TelemetryAPI["deleteLocalData"]>().mockResolvedValue({
      success: true,
      deletedFiles: 0,
      deletedBytes: 0,
      remainingFiles: 0,
      remainingBytes: 0,
      failedFiles: 0,
    }),
    onLogError: vi.fn<TelemetryAPI["onLogError"]>().mockReturnValue(() => {}),
    onLogEvent: vi.fn<TelemetryAPI["onLogEvent"]>((cb) => {
      capturedLogEventCallback = cb;
      return mockUnsubscribe;
    }),
    onFinalize: vi.fn<TelemetryAPI["onFinalize"]>().mockReturnValue(() => {}),
    rendererFinalized: vi
      .fn<TelemetryAPI["rendererFinalized"]>()
      .mockResolvedValue({ success: true }),
  };
});

afterEach(() => {
  delete window.telemetryAPI;
});

function renderBridge() {
  return render(
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">
        <div />
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
}

describe("TelemetryEventBridge", () => {
  it("subscribes to onLogEvent on mount", () => {
    renderBridge();
    expect(window.telemetryAPI!.onLogEvent).toHaveBeenCalledOnce();
  });

  it("calls unsubscribe on unmount", () => {
    const { unmount } = renderBridge();
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledOnce();
  });

  it("emits a Fetch event with correct scenario and misc when an event arrives", () => {
    renderBridge();
    expect(capturedLogEventCallback).toBeDefined();

    capturedLogEventCallback!({
      scenario: "LlmTokenUsage",
      fields: {
        sessionId: "sess-1",
        model: "gpt-4o",
        inputTokens: 100,
        outputTokens: 50,
        duration: 2000,
        source: "HostApp",
        type: "llm-usage",
      },
    });

    expect(mockLogFetchEvent).toHaveBeenCalledOnce();
    const emitted = mockLogFetchEvent.mock.calls[0][0];
    expect(emitted.scenario).toBe("LlmTokenUsage");
    expect(emitted.source).toBe("HostApp");
    expect(emitted.duration).toBe(2000);
    expect(emitted.sessionCorrelationId).toBe("test-session-correlation");
    expect(emitted.userId).toBe("test-user");
    expect(emitted.tenantId).toBe("test-tenant");

    // Verify misc shape
    const misc: Record<string, unknown> = JSON.parse(String(emitted.misc));
    expect(misc.sessionId).toBe("sess-1");
    expect(misc.model).toBe("gpt-4o");
    expect(misc.inputTokens).toBe(100);
    expect(misc.outputTokens).toBe(50);
  });

  it("does not forward provider request correlation IDs", () => {
    renderBridge();

    capturedLogEventCallback!({
      scenario: "LlmTokenUsage",
      fields: {
        apiCallId: "explicit-call-id",
        providerCallId: "provider-call-id",
        duration: 100,
        source: "HostApp",
      },
    });
    expect(mockLogFetchEvent.mock.calls[0][0].requestCorrelationId).toBeUndefined();
    expect(mockLogFetchEvent.mock.calls[0][0].responseCorrelationId).toBeUndefined();
  });

  it("excludes promoted fields from misc to avoid duplication", () => {
    renderBridge();

    capturedLogEventCallback!({
      scenario: "LlmTokenUsage",
      fields: {
        sessionId: "sess-1",
        model: "gpt-4o",
        inputTokens: 100,
        duration: 2000,
        source: "HostApp",
        type: "llm-usage",
        apiCallId: "call-1",
        providerCallId: "prov-1",
        moduleName: "LLM",
        scenario: "LlmTokenUsage",
      },
    });

    const misc: Record<string, unknown> = JSON.parse(
      String(mockLogFetchEvent.mock.calls[0][0].misc),
    );
    expect(misc).not.toHaveProperty("type");
    expect(misc).not.toHaveProperty("duration");
    expect(misc).not.toHaveProperty("source");
    expect(misc).not.toHaveProperty("apiCallId");
    expect(misc).not.toHaveProperty("providerCallId");
    expect(misc).not.toHaveProperty("moduleName");
    expect(misc).not.toHaveProperty("scenario");
    // Non-promoted fields are kept
    expect(misc.sessionId).toBe("sess-1");
    expect(misc.model).toBe("gpt-4o");
    expect(misc.inputTokens).toBe(100);
  });

  it("does not accumulate listeners under StrictMode double-mount", () => {
    // StrictMode mount → unmount → mount should result in exactly one active subscription.
    const { unmount } = renderBridge();

    // Simulate StrictMode: unmount and re-render
    unmount();
    renderBridge();

    // onLogEvent should have been called for each mount (2 total: initial + re-mount).
    // The first mount's cleanup should have called unsubscribe once.
    // Net: 1 active subscription.
    expect(mockUnsubscribe).toHaveBeenCalledOnce(); // first mount cleaned up
    expect(window.telemetryAPI!.onLogEvent).toHaveBeenCalledTimes(2);

    // Fire an event — should reach logFetchEvent exactly once (not twice)
    capturedLogEventCallback!({
      scenario: "Test",
      fields: { key: "val" },
    });
    expect(mockLogFetchEvent).toHaveBeenCalledOnce();
  });
});
