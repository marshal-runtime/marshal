import { performance } from "node:perf_hooks";

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";

import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import { ipcErrors, makeIpcError } from "../../common/telemetry/errors/marshal-ipc";
import { shouldUseRealE2EHandler } from "../e2e-stub-routing";
import { isMockMode } from "../mock-mode";
import { writeProcessLifecycleEventSync } from "../process-lifecycle-diagnostics";
import { hasTelemetryMarker, sendErrorTelemetry } from "../telemetry-errors";

const log = createLogger("IPC");
const SLOW_IPC_HANDLER_MS = 250;
const authorizedWebContents = new Set<number>();
const registeredIpcChannels = new Set<string>();

export function listRegisteredIpcChannels(): readonly string[] {
  return [...registeredIpcChannels].sort((left, right) => left.localeCompare(right));
}

export function authorizeIpcWebContents(id: number): () => void {
  authorizedWebContents.add(id);
  return () => authorizedWebContents.delete(id);
}

export class UnauthorizedSenderError extends Error {
  readonly code = "unauthorized_sender";
  constructor(public readonly channel: string) {
    super("unauthorized sender");
    this.name = "UnauthorizedSenderError";
  }
}

// Electron security guide §17 (validate sender). Stricter than the documented
// URL-allowlist example: enforce main-frame-only by reference equality, which
// avoids URL-parser surface and is robust against a sub-frame navigating to
// an allowlisted origin between send and handle.
export function assertMainFrame(event: IpcMainInvokeEvent, channel: string): void {
  if (event.senderFrame !== event.sender.mainFrame) {
    rejectUnauthorizedSender(channel);
  }
}

function assertAuthorizedIpcSender(event: IpcMainInvokeEvent, channel: string): void {
  if (!authorizedWebContents.has(event.sender.id)) {
    log.warn("Unauthorized IPC sender", { channel, webContentsId: event.sender.id });
    rejectUnauthorizedSender(channel);
  }
  assertMainFrame(event, channel);
}

function rejectUnauthorizedSender(channel: string): never {
  const err = new UnauthorizedSenderError(channel);
  sendErrorTelemetry(makeIpcError(ipcErrors.UNAUTHORIZED_SENDER), err);
  log.event("ipc.unauthorized_sender", { channel });
  throw err;
}

/**
 * Creates a mock-mode-aware wrapper around ipcMain.handle().
 * When mock mode is active, handlers return stub responses from e2e-stubs.ts
 * instead of executing real logic. Use this instead of ipcMain.handle() for
 * handlers that need to work in E2E tests.
 *
 * All channels must be declared in IpcInvokeMap — the compiler enforces
 * that handler argument and return types match the contract.
 */
export function createIpcHandle() {
  return function ipcHandle<C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) {
    registeredIpcChannels.add(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      const startedAt = performance.now();
      let outcome: "success" | "error" = "success";
      try {
        assertAuthorizedIpcSender(event, channel);
        if (isMockMode() && !shouldUseRealE2EHandler(channel)) {
          const { E2E_STUBS, E2E_DYNAMIC_STUBS } = await import("../e2e-stubs");
          if (channel in E2E_DYNAMIC_STUBS) {
            const result = E2E_DYNAMIC_STUBS[channel](...args);
            // Dynamic stubs return undefined to signal "fall through to real handler"
            if (result !== undefined) return result;
          } else if (channel in E2E_STUBS) {
            return E2E_STUBS[channel];
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion -- IPC handler dispatch: args are type-safe at call sites via IpcInvokeMap
        return await (handler as any)(event, ...args);
      } catch (err) {
        outcome = "error";
        // Skip if the thrown error was already telemetered at a deeper layer
        // (e.g., auth/session/mcp emit-sites mark their errors before rethrow).
        // Prevents one user action from producing duplicate telemetry events across
        // families.
        if (!hasTelemetryMarker(err)) {
          sendErrorTelemetry(makeIpcError(ipcErrors.HANDLER_UNCAUGHT));
        }
        throw err;
      } finally {
        const durationMs = performance.now() - startedAt;
        if (durationMs >= SLOW_IPC_HANDLER_MS) {
          writeProcessLifecycleEventSync("ipc.handler.slow", {
            channel,
            durationMs: Math.round(durationMs * 100) / 100,
            outcome,
            argumentCount: args.length,
            webContentsId: event.sender.id,
          });
        }
      }
    });
  };
}
