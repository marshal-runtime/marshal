import { registerAllErrors } from "@common/telemetry/errors/marshal-index";
import type { MidgardError } from "@common/telemetry/types";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { TelemetryAPI } from "../../../common/marshal-ipc-contract";
import { render } from "../../test-utils";
import {
  CopyTagsToFields,
  emptyTelemetryContextProps,
  makeTelemetryCallbacks,
  schema,
} from "./opensource";
import { TagGdprEvents } from "./TagGdprEvents";
import { TelemetryErrorRouter } from "./TelemetryErrorRouter";
import { TelemetryInstanceContext } from "./TelemetryInstanceContext";
import { createCaptureSink } from "./test-utils";

const { sinkManager, events } = createCaptureSink();

function makeTelemetry() {
  const telemetryCallbacks = makeTelemetryCallbacks(
    { sinkManagers: [sinkManager], middlewares: [TagGdprEvents, CopyTagsToFields] },
    schema,
  );
  registerAllErrors(telemetryCallbacks);
  return { telemetryCallbacks, telemetryContextProps: { ...emptyTelemetryContextProps } };
}

beforeEach(() => {
  events.splice(0);
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

it("subscribes to onLogError once and emits an Error event with empty sessionCorrelationId", () => {
  const telemetry = makeTelemetry();
  render(
    <TelemetryInstanceContext.Provider value={telemetry}>
      <TelemetryErrorRouter />
    </TelemetryInstanceContext.Provider>,
  );

  expect(window.telemetryAPI!.onLogError).toHaveBeenCalledTimes(1);

  // Invoke the registered callback (not routeError directly) so the IPC→router wire is exercised.
  const [registeredCb] = vi.mocked(window.telemetryAPI!.onLogError).mock.calls[0];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: only messageId is read
  registeredCb({ messageId: "boom" } as unknown as MidgardError);

  const errorEvent = events.find((e) => e.eventType === "Marshal.Error");
  expect(errorEvent).toBeDefined();
  // Out-of-session: getSessionCorrelationId() returns "", which the telemetry schema's
  // omitEmpty strips entirely (same as fields.hostAppRing in TelemetryProvider.test).
  // The field's absence is the proof no session id leaks into pre-login errors.
  expect((errorEvent!.fields as Record<string, unknown>).sessionCorrelationId).toBeUndefined();
});

it("survives React.StrictMode double-mount with a single live out-of-session logger", () => {
  const telemetry = makeTelemetry();
  render(
    <StrictMode>
      <TelemetryInstanceContext.Provider value={telemetry}>
        <TelemetryErrorRouter />
      </TelemetryInstanceContext.Provider>
    </StrictMode>,
  );

  // One live registrant after the StrictMode cycle: invoke the last callback, expect one event.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: only messageId is read
  vi.mocked(window.telemetryAPI!.onLogError).mock.calls.at(-1)![0]({
    messageId: "boom",
  } as unknown as MidgardError);

  expect(events.filter((e) => e.eventType === "Marshal.Error")).toHaveLength(1);
});
