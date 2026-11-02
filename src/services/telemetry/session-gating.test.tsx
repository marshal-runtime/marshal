import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { sessionGateStage } from "@/features/auth/sessionGate";
import { SessionScope, TelemetryInstanceProvider } from "@/services/telemetry";
import { RenderScenarioProvider } from "@/services/telemetry/RenderScenarioProvider";
import { createCaptureSink, sinkSetup } from "@/services/telemetry/test-utils";
import { render, waitFor } from "@/test-utils";

import type { TelemetryAPI } from "../../../common/marshal-ipc-contract";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

// Drives SessionScope through the real AuthGate gate (sessionGateStage), so the
// lifecycle below exercises the actual gating decision, not a hand-rolled mirror.
function Harness({ ready }: { ready: boolean }) {
  const gate = sessionGateStage(ready ? { kind: "ready" } : { kind: "start" });
  return gate === null ? (
    <SessionScope>
      <RenderScenarioProvider view="chat">
        <div data-testid="app" />
      </RenderScenarioProvider>
    </SessionScope>
  ) : (
    <div data-testid="auth" />
  );
}

const start = () => events.filter((e) => e.eventType === "Marshal.SessionStart").length;
const end = () => events.filter((e) => e.eventType === "Marshal.SessionEnd").length;
const firstStart = () => events.find((e) => e.eventType === "Marshal.SessionStart");

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

it("emits no SessionStart before ready", () => {
  render(
    <TelemetryInstanceProvider>
      <Harness ready={false} />
    </TelemetryInstanceProvider>,
  );
  expect(start()).toBe(0);
});

it("emits SessionStart immediately when auth is ready", async () => {
  render(
    <TelemetryInstanceProvider>
      <Harness ready />
    </TelemetryInstanceProvider>,
  );
  await waitFor(() => expect(start()).toBe(1));
});

it("emits exactly one SessionStart on entering ready", async () => {
  const { rerender } = render(
    <TelemetryInstanceProvider>
      <Harness ready={false} />
    </TelemetryInstanceProvider>,
  );
  rerender(
    <TelemetryInstanceProvider>
      <Harness ready />
    </TelemetryInstanceProvider>,
  );
  await waitFor(() => expect(start()).toBe(1));
});

it("SessionStart omits identity on a first-render-ready mount", async () => {
  render(
    <TelemetryInstanceProvider>
      <Harness ready />
    </TelemetryInstanceProvider>,
  );
  await waitFor(() => expect(start()).toBe(1));
  const fields = firstStart()!.fields as Record<string, unknown>;
  expect(fields.userId).toBeUndefined();
  expect(fields.tenantId).toBeUndefined();
});

it("emits SessionEnd without identity when leaving ready", async () => {
  const { rerender } = render(
    <TelemetryInstanceProvider>
      <Harness ready />
    </TelemetryInstanceProvider>,
  );
  await waitFor(() => expect(start()).toBe(1));
  rerender(
    <TelemetryInstanceProvider>
      <Harness ready={false} />
    </TelemetryInstanceProvider>,
  );
  await waitFor(() => expect(end()).toBe(1));
  const fields = events.find((e) => e.eventType === "Marshal.SessionEnd")!.fields as Record<
    string,
    unknown
  >;
  expect(fields.userId).toBeUndefined();
  expect(fields.tenantId).toBeUndefined();
});
