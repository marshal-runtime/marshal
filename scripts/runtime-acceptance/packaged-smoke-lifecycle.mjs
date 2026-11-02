const STARTUP_FAILURE_EVENTS = new Set([
  "process.uncaughtException",
  "process.unhandledRejection",
  "main.startup.failed",
  "marshal-runtime.host.failed",
  "main-window.render-process-gone",
]);

export function findPackagedStartupFailure(events) {
  return events.find((entry) => STARTUP_FAILURE_EVENTS.has(entry.event)) ?? null;
}
