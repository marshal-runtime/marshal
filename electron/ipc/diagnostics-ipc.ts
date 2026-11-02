import fs from "node:fs";
import path from "node:path";

import { shell } from "electron";

import { getLogFilePath, writeDiagnosticEntry } from "../diagnostic-logger";
import { sanitizeForTelemetry } from "../marshal-value-sanitization";
import type { RendererResponsivenessMonitor } from "../renderer-responsiveness-monitor";
import type { IpcDeps } from "./types";

interface DiagnosticsHandlerDeps extends Pick<IpcDeps, "ipcHandle"> {
  rendererResponsivenessMonitor: Pick<RendererResponsivenessMonitor, "recordHeartbeat">;
}

export function registerDiagnosticsHandlers({
  ipcHandle,
  rendererResponsivenessMonitor,
}: DiagnosticsHandlerDeps) {
  ipcHandle("diagnostics:rendererHeartbeat", (event, heartbeat) =>
    rendererResponsivenessMonitor.recordHeartbeat(event.sender.id, heartbeat),
  );

  ipcHandle(
    "diagnostics:log",
    (
      _event,
      entry: {
        level: "error" | "warn" | "info";
        category: string;
        message: string;
        metadata?: Record<string, unknown>;
      },
    ) => {
      // Runtime validation — TS types are compile-time only
      if (!entry || typeof entry !== "object") {
        return { success: false, error: "Invalid payload" };
      }
      if (!["error", "warn", "info"].includes(entry.level)) {
        return { success: false, error: `Invalid level: ${entry.level}` };
      }
      if (typeof entry.category !== "string" || !entry.category.trim()) {
        return { success: false, error: "Category is required" };
      }
      if (typeof entry.message !== "string" || !entry.message.trim()) {
        return { success: false, error: "Message is required" };
      }
      writeDiagnosticEntry(entry);
      return { success: true };
    },
  );

  ipcHandle("diagnostics:getLogPath", () => {
    return { success: true, path: getLogFilePath() };
  });

  ipcHandle("diagnostics:revealLogFolder", () => {
    try {
      const logPath = getLogFilePath();
      if (fs.existsSync(logPath)) {
        shell.showItemInFolder(logPath);
      } else {
        void shell.openPath(path.dirname(logPath));
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("diagnostics:sanitize", (_event, text: string) => {
    return { success: true, sanitized: sanitizeForTelemetry(text) };
  });
}
