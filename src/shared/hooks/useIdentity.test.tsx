import * as React from "react";
import { it, expect, beforeEach, vi } from "vitest";

import { TelemetryProvider } from "@/services/telemetry";
import type { SinkSetup } from "@/services/telemetry/makeTelemetrySinkManagers";
import type { TelemetryEvent } from "@/services/telemetry/opensource";
import { RenderScenarioProvider } from "@/services/telemetry/RenderScenarioProvider";
import { createCaptureSink, sinkSetup } from "@/services/telemetry/test-utils";
import { installMockAPIs, render, waitFor } from "@/test-utils";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  get makeTelemetrySinkManagers() {
    return vi.fn<() => SinkSetup>().mockReturnValue(sinkSetup(sinkManager));
  },
}));

beforeEach(() => {
  events.splice(0);
  installMockAPIs();
});

it("TelemetryProvider fires SessionStart even while identity:get is still in-flight", async () => {
  // Regression test: TelemetryProvider must not wait for identity to start a
  // session. The preload-seeded refs handle warm-user session-start identity;
  // the async identity:get updates refs for later events.
  vi.mocked(window.identityAPI!.get).mockImplementation(() => new Promise(() => {}));

  render(
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">
        <div />
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );

  await waitFor(() =>
    expect(events.some((e: TelemetryEvent) => e.eventType === "Marshal.SessionStart")).toBe(true),
  );
});

it("AuthScreen unmount does not fire SessionEnd", async () => {
  // Regression guard: RenderScenarioProvider fires endSession() on unmount.
  // AuthScreen uses RenderMonitorContext.Provider directly instead, which has
  // no cleanup side effects. A refactor back to RenderScenarioProvider would
  // prematurely end the session when auth completes, corrupting duration.
  //
  // Uses rerender (not unmount) to replace only AuthScreen while keeping
  // TelemetryProvider + outer RenderScenarioProvider mounted — same as AuthGate
  // switching from AuthScreen to AppRoutes on login.
  const { AuthScreen } = await import("@/features/auth/AuthScreen");
  const actions = {
    signInGitHub: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    signOutAll: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    reset: vi.fn<() => void>(),
  };
  const wrap = (child: React.ReactNode) => (
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">{child}</RenderScenarioProvider>
    </TelemetryProvider>
  );
  const { rerender } = render(
    wrap(<AuthScreen stage={{ kind: "start", error: undefined }} actions={actions} />),
  );

  await waitFor(() =>
    expect(events.some((e: TelemetryEvent) => e.eventType === "Marshal.SessionStart")).toBe(true),
  );

  rerender(wrap(<div />));

  await new Promise((r) => setTimeout(r, 50));
  expect(events.filter((e: TelemetryEvent) => e.eventType === "Marshal.SessionEnd")).toHaveLength(
    0,
  );
});
