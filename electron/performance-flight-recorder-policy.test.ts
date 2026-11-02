import { describe, expect, test } from "vitest";

import {
  normalizePerformanceFlightRecorderEnv,
  PERFORMANCE_FLIGHT_RECORDER_ENV,
} from "./performance-flight-recorder-policy";

describe("normalizePerformanceFlightRecorderEnv", () => {
  test("disables recording by default", () => {
    const env: Record<string, string | undefined> = {};

    normalizePerformanceFlightRecorderEnv(env);

    expect(env[PERFORMANCE_FLIGHT_RECORDER_ENV]).toBe("0");
  });

  test("requires an explicit one to enable recording", () => {
    const enabled = { [PERFORMANCE_FLIGHT_RECORDER_ENV]: "1" };
    const truthy = { [PERFORMANCE_FLIGHT_RECORDER_ENV]: "true" };

    normalizePerformanceFlightRecorderEnv(enabled);
    normalizePerformanceFlightRecorderEnv(truthy);

    expect(enabled[PERFORMANCE_FLIGHT_RECORDER_ENV]).toBe("1");
    expect(truthy[PERFORMANCE_FLIGHT_RECORDER_ENV]).toBe("0");
  });
});
