export const PERFORMANCE_FLIGHT_RECORDER_ENV = "MARSHAL_PERFORMANCE_FLIGHT_RECORDER";

type PerformanceFlightRecorderEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function normalizePerformanceFlightRecorderEnv(env: PerformanceFlightRecorderEnv): void {
  env[PERFORMANCE_FLIGHT_RECORDER_ENV] = env[PERFORMANCE_FLIGHT_RECORDER_ENV] === "1" ? "1" : "0";
}
