// Ownership: renderer diagnostic logging.

/**
 * Renderer-side diagnostic logger — thin wrapper around the diagnostics IPC.
 *
 * Usage:
 *   diagnosticLog.error("crash", "React tree crashed", { errorName, errorStack });
 *   diagnosticLog.info("mcp", "Server connected", { name: "filesystem" });
 */

type DiagnosticLevel = "error" | "warn" | "info";

function log(
  level: DiagnosticLevel,
  category: string,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  window.diagnosticsAPI?.log({ level, category, message, metadata }).catch(() => {});
}

export const diagnosticLog = {
  error(category: string, message: string, metadata?: Record<string, unknown>) {
    log("error", category, message, metadata);
  },
  warn(category: string, message: string, metadata?: Record<string, unknown>) {
    log("warn", category, message, metadata);
  },
  info(category: string, message: string, metadata?: Record<string, unknown>) {
    log("info", category, message, metadata);
  },
};
