import * as React from "react";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

import type { TelemetryAPI } from "../../../common/marshal-ipc-contract";
import { render, waitFor } from "../../test-utils";
import { TelemetryProvider } from "./index";
import { useTelemetry } from "./opensource";
import { RenderScenarioProvider } from "./RenderScenarioProvider";
import { createCaptureSink, sinkSetup } from "./test-utils";

const { sinkManager, events } = createCaptureSink();

const makeTelemetrySinkManagersMock = vi.fn<
  (telemetryEnabled: boolean) => {
    sinkManagers: unknown[];
  }
>(() => sinkSetup(sinkManager));

vi.mock("./makeTelemetrySinkManagers", () => ({
  get makeTelemetrySinkManagers() {
    return makeTelemetrySinkManagersMock;
  },
}));

beforeEach(() => {
  events.splice(0);
  makeTelemetrySinkManagersMock.mockClear();
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
    onLogEvent: vi.fn<TelemetryAPI["onLogEvent"]>().mockReturnValue(() => {}),
    onFinalize: vi.fn<TelemetryAPI["onFinalize"]>().mockReturnValue(() => {}),
    rendererFinalized: vi
      .fn<TelemetryAPI["rendererFinalized"]>()
      .mockResolvedValue({ success: true }),
  };
});

afterEach(() => {
  delete window.telemetryAPI;
});

it("emits SessionStart when TelemetryProvider mounts", async () => {
  render(
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">
        <div />
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
  await waitFor(() =>
    expect(events.some((e) => e.eventType === "Marshal.SessionStart")).toBe(true),
  );
});

it("emits SessionEnd when TelemetryProvider unmounts", async () => {
  const { unmount } = render(
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">
        <div />
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
  await waitFor(() =>
    expect(events.some((e) => e.eventType === "Marshal.SessionStart")).toBe(true),
  );
  unmount();
  await waitFor(() => expect(events.some((e) => e.eventType === "Marshal.SessionEnd")).toBe(true));
});

it("emits Render event when view changes", async () => {
  const { rerender } = render(
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">
        <div />
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
  // Wait for the first mount to settle so the rerender below is a real transition.
  await waitFor(() =>
    expect(events.some((e) => e.eventType === "Marshal.SessionStart")).toBe(true),
  );
  rerender(
    <TelemetryProvider>
      <RenderScenarioProvider view="settings">
        <div />
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
  await waitFor(() => expect(events.some((e) => e.eventType === "Marshal.Render")).toBe(true));
  const renderEvent = events.find((event) => event.eventType === "Marshal.Render");
  expect(renderEvent?.fields.targetView).toBe("chat");
  expect(renderEvent?.fields.duration).toEqual(expect.any(Number));
});

it("finalizes SessionEnd exactly once on pagehide", async () => {
  const { unmount } = render(
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">
        <div />
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
  await waitFor(() =>
    expect(events.some((event) => event.eventType === "Marshal.SessionStart")).toBe(true),
  );

  window.dispatchEvent(new Event("pagehide"));
  await waitFor(() =>
    expect(events.filter((event) => event.eventType === "Marshal.SessionEnd")).toHaveLength(1),
  );
  const renderIndex = events.findIndex((event) => event.eventType === "Marshal.Render");
  const sessionEndIndex = events.findIndex((event) => event.eventType === "Marshal.SessionEnd");
  expect(renderIndex).toBeGreaterThanOrEqual(0);
  expect(renderIndex).toBeLessThan(sessionEndIndex);

  unmount();
  expect(events.filter((event) => event.eventType === "Marshal.SessionEnd")).toHaveLength(1);
});

it("populates required and softRequired common fields on SessionStart", async () => {
  render(
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">
        <div />
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );

  await waitFor(() =>
    expect(events.some((e) => e.eventType === "Marshal.SessionStart")).toBe(true),
  );

  const sessionStart = events.find((e) => e.eventType === "Marshal.SessionStart")!;
  const fields = sessionStart.fields as Record<string, unknown>;

  // Required common fields
  expect(fields.appVersion).toBe("0.0.0-test");
  expect(fields.appName).toBe("Marshal");
  expect(fields.complianceEnvironment).toBe("Df");
  expect(fields.hostApp).toBe("Marshal");
  expect(fields.tenantId).toBeUndefined();
  expect(fields.userId).toBeUndefined();
  expect(fields.userPuid).toBeUndefined();

  // sessionCorrelationId and hostAppSessionCorrelationId must be the same non-empty GUID
  expect(fields.sessionCorrelationId).toBeTruthy();
  expect(fields.hostAppSessionCorrelationId).toBe(fields.sessionCorrelationId);

  // SoftRequired common fields
  expect(fields.hostAppPlatform).toBe("Desktop");
  expect(fields.hostAppRing).toBeUndefined(); // stripped by omitEmpty
  expect(fields.hostAppVersion).toBe("0.0.0-test");
  expect(fields.eventUniqueIdentifier).toBeTruthy();

  // Per-event fields (SessionStart-specific)
  expect(fields.gesture).toBe("hostApp");
  expect(fields.flights).toBe("[]");
  expect(fields.ecsConfigIds).toBe("[]");

  // GDPR tags (handled by TagGdprEvents middleware, surfaced via CopyTagsToFields)
  expect(fields.isGdprExportable).toBe(true);
  expect(fields.gdprExportActionName).toBe("OpenedMarshal");
});

it("uses focusLeave for SessionEnd", async () => {
  const { unmount } = render(
    <TelemetryProvider>
      <div />
    </TelemetryProvider>,
  );
  unmount();

  await waitFor(() => {
    const sessionEnd = events.find((event) => event.eventType === "Marshal.SessionEnd");
    expect(sessionEnd?.fields.gesture).toBe("focusLeave");
  });
});

describe("TelemetryProvider sink wiring", () => {
  it("passes the enabled setting to makeTelemetrySinkManagers", () => {
    render(
      <TelemetryProvider>
        <RenderScenarioProvider view="chat">
          <div />
        </RenderScenarioProvider>
      </TelemetryProvider>,
    );
    expect(makeTelemetrySinkManagersMock).toHaveBeenCalledWith(true);
  });

  it("passes telemetryEnabled=false", () => {
    render(
      <TelemetryProvider telemetryEnabled={false}>
        <RenderScenarioProvider view="chat">
          <div />
        </RenderScenarioProvider>
      </TelemetryProvider>,
    );
    expect(makeTelemetrySinkManagersMock).toHaveBeenCalledWith(false);
  });

  it("does not rebuild the sink when telemetryEnabled changes mid-session", async () => {
    const { rerender } = render(
      <TelemetryProvider>
        <RenderScenarioProvider view="chat">
          <div />
        </RenderScenarioProvider>
      </TelemetryProvider>,
    );
    expect(makeTelemetrySinkManagersMock).toHaveBeenCalledTimes(1);

    rerender(
      <TelemetryProvider telemetryEnabled={false}>
        <RenderScenarioProvider view="settings">
          <div />
        </RenderScenarioProvider>
      </TelemetryProvider>,
    );
    await waitFor(() => expect(events.some((e) => e.eventType === "Marshal.Render")).toBe(true));

    expect(makeTelemetrySinkManagersMock).toHaveBeenCalledTimes(1);
  });
});

it("child mount effects see a non-empty sessionCorrelationId", async () => {
  // Regression test for the useEffect ordering race: TelemetryContextProvider calls
  // startSession in useEffect, but React runs child effects before parent effects.
  // Without a fix, child components reading getSessionCorrelationId() in their own
  // mount effect (or firing events triggered by mount effects) get "".
  let sessionCorrelationIdInChildEffect = "";

  function Probe() {
    const telemetry = useTelemetry();
    React.useEffect(() => {
      sessionCorrelationIdInChildEffect = telemetry.telemetryContextProps.getSessionCorrelationId();
    }, [telemetry.telemetryContextProps]);
    return null;
  }

  render(
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">
        <Probe />
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );

  await waitFor(() => {
    expect(sessionCorrelationIdInChildEffect).toBeTruthy();
  });
});

it("TelemetryInstanceProvider alone does not emit SessionStart; SessionScope does", async () => {
  const { TelemetryInstanceProvider, SessionScope } = await import("./index");
  const { rerender } = render(
    <TelemetryInstanceProvider>
      <div data-testid="no-session" />
    </TelemetryInstanceProvider>,
  );
  // No session events from the instance provider on its own.
  expect(events.some((e) => e.eventType === "Marshal.SessionStart")).toBe(false);

  rerender(
    <TelemetryInstanceProvider>
      <SessionScope>
        <RenderScenarioProvider view="chat">
          <div />
        </RenderScenarioProvider>
      </SessionScope>
    </TelemetryInstanceProvider>,
  );
  await waitFor(() =>
    expect(events.some((e) => e.eventType === "Marshal.SessionStart")).toBe(true),
  );
});
