import { describe, expect, it, vi } from "vitest";

import { TelemetryProvider } from "@/services/telemetry";
import { createCaptureSink, findUserAction, sinkSetup } from "@/services/telemetry/test-utils";
import { render, screen, userEvent } from "@/test-utils";

import * as components from "./components";
import { MARSHAL_DATA_CONTRACT_ID } from "./contract";
import {
  booleanProperties,
  InteractiveElementMonitor_Switch,
  interactiveElements,
  nonInteractiveElements,
  stringProperties,
} from "./measures";

const { sinkManager, events } = createCaptureSink();

vi.mock("@/services/telemetry/makeTelemetrySinkManagers", () => ({
  makeTelemetrySinkManagers: () => sinkSetup(sinkManager),
}));

const componentNames = Object.keys(components)
  .filter((key) => key.startsWith("TelemetryPath_"))
  .map((key) => key.slice("TelemetryPath_".length));

const allMeasures = [
  ...Object.values(interactiveElements),
  ...Object.values(nonInteractiveElements),
  ...Object.values(booleanProperties),
  ...Object.values(stringProperties),
];

describe("telemetry schema", () => {
  it("stamps every measure with the Marshal data contract id", () => {
    expect(allMeasures.length).toBeGreaterThan(0);
    for (const measure of allMeasures) {
      expect(measure.dataContractId).toBe(MARSHAL_DATA_CONTRACT_ID);
    }
  });

  it("keys every measure table by the measure's own name", () => {
    for (const table of [
      interactiveElements,
      nonInteractiveElements,
      booleanProperties,
      stringProperties,
    ]) {
      for (const [key, measure] of Object.entries(table)) {
        expect(measure.name).toBe(key);
      }
    }
  });

  // An expectedPath segment that no component declares can never be produced by
  // the renderer, so the row would silently document an unreachable emit site.
  it("builds every expectedPath segment from a declared component", () => {
    const known = new Set(componentNames);
    for (const measure of allMeasures) {
      for (const path of measure.expectedPaths) {
        for (const segment of path.split("/").filter(Boolean)) {
          expect(known, `${measure.name} → ${path}`).toContain(segment);
        }
      }
    }
  });

  it("carries no inherited provider vocabulary", () => {
    const inherited = /Horizon|Personality|Hugin|Aria/;
    for (const name of [...componentNames, ...allMeasures.map((m) => m.name)]) {
      expect(name).not.toMatch(inherited);
    }
  });

  it("emits a UserAction carrying the action and nested component path", async () => {
    const user = userEvent.setup();
    render(
      <TelemetryProvider>
        <components.TelemetryPath_App>
          <components.TelemetryPath_Settings>
            <components.TelemetryPath_Model>
              <InteractiveElementMonitor_Switch callback={() => {}}>
                {(cb) => (
                  <button type="button" onClick={cb}>
                    switch
                  </button>
                )}
              </InteractiveElementMonitor_Switch>
            </components.TelemetryPath_Model>
          </components.TelemetryPath_Settings>
        </components.TelemetryPath_App>
      </TelemetryProvider>,
    );

    await user.click(screen.getByText("switch"));

    const event = findUserAction(events, "Switch", "/App/Settings/Model");
    expect(event).toBeDefined();
    expect((event!.fields as Record<string, unknown>).dataContractId).toBe(
      MARSHAL_DATA_CONTRACT_ID,
    );
  });
});
