import type { LocalTelemetryEventPayload } from "../../common/local-telemetry";
import { createLogger } from "../../common/marshal-logger";
import { sanitizeLocalTelemetryEvent } from "../local-telemetry-store";
import type { LocalTelemetryStore } from "../local-telemetry-store";
import { checkStringSize, IPC_LIMITS } from "./ipc-limits";
import type { IpcDeps } from "./types";

const log = createLogger("TelemetryIPC");

type LocalTelemetryStorePort = Pick<LocalTelemetryStore, "append" | "deleteAll" | "prune">;

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : "unknown";
}

export function registerTelemetryHandlers(
  { ipcHandle }: Pick<IpcDeps, "ipcHandle">,
  store: LocalTelemetryStorePort,
  collectionEnabledAtLaunch: boolean,
  lifecycle?: { onRendererFinalized?: () => void },
): void {
  void store
    .prune()
    .catch((error) =>
      log.warn("Initial local telemetry pruning failed", { code: errorCode(error) }),
    );

  ipcHandle("telemetry:write-local-event", async (_event, payload: LocalTelemetryEventPayload) => {
    if (!collectionEnabledAtLaunch) {
      return {
        success: false,
        error: "Local telemetry collection is disabled until Marshal restarts.",
      };
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return { success: false, error: "Invalid local telemetry event." };
    }
    const sizeError = checkStringSize(
      serialized,
      IPC_LIMITS.TELEMETRY_EVENT_BYTES,
      "Telemetry event",
    );
    if (sizeError) return sizeError;

    const sanitized = sanitizeLocalTelemetryEvent(payload);
    if (!sanitized) {
      return { success: false, error: "Unsupported or invalid local telemetry event." };
    }

    try {
      await store.append(sanitized);
      return { success: true };
    } catch {
      return { success: false, error: "Failed to write local telemetry data." };
    }
  });

  ipcHandle("telemetry:delete-local-data", async () => {
    try {
      const deleted = await store.deleteAll();
      const counts = {
        deletedFiles: deleted.deletedFiles,
        deletedBytes: deleted.deletedBytes,
        remainingFiles: deleted.remainingFiles,
        remainingBytes: deleted.remainingBytes,
        failedFiles: deleted.failedFiles,
      };
      if (deleted.complete) return { success: true, ...counts };
      const details = [
        deleted.remainingBytes > 0
          ? `${deleted.remainingBytes} byte${deleted.remainingBytes === 1 ? "" : "s"} remain`
          : null,
        deleted.failedFiles > 0
          ? `${deleted.failedFiles} file${deleted.failedFiles === 1 ? "" : "s"} could not be verified`
          : null,
      ].filter((value): value is string => value !== null);
      return {
        success: false,
        ...counts,
        error:
          details.length > 0
            ? `Local telemetry deletion was incomplete: ${details.join("; ")}.`
            : "Local telemetry deletion could not be verified.",
      };
    } catch {
      return {
        success: false,
        deletedFiles: 0,
        deletedBytes: 0,
        remainingFiles: 0,
        remainingBytes: 0,
        failedFiles: 1,
        error: "Failed to delete local telemetry data.",
      };
    }
  });

  ipcHandle("telemetry:renderer-finalized", () => {
    lifecycle?.onRendererFinalized?.();
    return { success: true };
  });
}
