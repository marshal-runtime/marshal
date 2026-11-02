import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import type { WhatsAppSidecarAuthStorePort } from "./auth-port";
import {
  decodeWhatsAppAuthValue,
  encodeWhatsAppAuthValue,
  parseWhatsAppSidecarParentFrame,
  serializeWhatsAppSidecarFrame,
  WHATSAPP_SIDECAR_SCHEMA_VERSION,
  type WhatsAppAuthStoreValue,
  type WhatsAppSidecarAuthRequest,
  type WhatsAppSidecarAuthResponse,
  type WhatsAppSidecarChildFrame,
  type WhatsAppSidecarCommand,
  type WhatsAppSidecarRequest,
  type WhatsAppSidecarRequestResponse,
} from "./protocol";
import {
  type CreateWhatsAppSocketAdapter,
  WhatsAppSidecarStateError,
  WhatsAppSocketController,
} from "./socket-controller";

export interface RunWhatsAppSidecarProcessOptions {
  input?: Readable;
  writeFrame?: (frame: WhatsAppSidecarChildFrame) => void;
  createSocket?: CreateWhatsAppSocketAdapter;
}

export async function runWhatsAppSidecarProcess(
  options: RunWhatsAppSidecarProcessOptions = {},
): Promise<void> {
  const input = createInterface({
    input: options.input ?? process.stdin,
    crlfDelay: Infinity,
  });
  const writeFrame =
    options.writeFrame ??
    ((frame: WhatsAppSidecarChildFrame) => {
      process.stdout.write(serializeWhatsAppSidecarFrame(frame));
    });
  const authStore = new ProcessAuthStoreRpc(writeFrame);
  const createSocket =
    options.createSocket ??
    (async (...args) => {
      const adapter = await import("./baileys-adapter");
      return adapter.createBaileysSocketAdapter(...args);
    });
  const controller = new WhatsAppSocketController({
    authStore,
    createSocket,
    emitEvent: (event) => {
      writeFrame({
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "event",
        event,
      });
    },
  });
  let operationQueue: Promise<void> = Promise.resolve();
  let shutdownRequested = false;

  writeFrame({
    schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
    kind: "ready",
    capabilities: {
      packageName: "baileys",
      packageVersion: "7.0.0-rc14",
      autoConnect: false,
      authPersistence: "parent-rpc",
    },
  });

  for await (const line of input) {
    let frame;
    try {
      frame = parseWhatsAppSidecarParentFrame(line);
    } catch (error) {
      authStore.close();
      await controller.shutdown().catch(() => undefined);
      writeFrame({
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "fatal",
        code: "PROTOCOL_ERROR",
        message: "WhatsApp sidecar received an invalid protocol frame.",
      });
      throw new WhatsAppProtocolError("WhatsApp sidecar protocol validation failed", {
        cause: error,
      });
    }
    if (frame.kind === "auth-response") {
      try {
        authStore.accept(frame);
      } catch (error) {
        authStore.close();
        await controller.shutdown().catch(() => undefined);
        writeFrame({
          schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
          kind: "fatal",
          code: "PROTOCOL_ERROR",
          message: "WhatsApp sidecar received an invalid protocol frame.",
        });
        throw error;
      }
      continue;
    }
    if (frame.kind === "request") {
      operationQueue = operationQueue.then(async () => {
        try {
          const response = await executeRequest(controller, frame.request);
          writeFrame({
            schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
            kind: "request-result",
            requestId: frame.requestId,
            requestType: frame.request.type,
            ok: true,
            response,
          });
        } catch (error) {
          writeFrame({
            schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
            kind: "request-result",
            requestId: frame.requestId,
            requestType: frame.request.type,
            ok: false,
            error: normalizeCommandError(error),
          });
        }
      });
      continue;
    }
    operationQueue = operationQueue.then(async () => {
      try {
        await executeCommand(controller, frame.command);
        writeFrame({
          schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
          kind: "command-result",
          requestId: frame.requestId,
          command: frame.command,
          ok: true,
        });
        if (frame.command === "shutdown") {
          shutdownRequested = true;
          input.close();
        }
      } catch (error) {
        const normalized = normalizeCommandError(error);
        writeFrame({
          schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
          kind: "command-result",
          requestId: frame.requestId,
          command: frame.command,
          ok: false,
          error: normalized,
        });
      }
    });
  }
  if (!shutdownRequested) authStore.close();
  await operationQueue;
  authStore.close();
  input.close();
  if (!shutdownRequested) {
    await controller.shutdown().catch(() => undefined);
    throw new Error("WhatsApp sidecar parent closed stdin before shutdown");
  }
}

async function executeRequest(
  controller: WhatsAppSocketController,
  request: WhatsAppSidecarRequest,
): Promise<WhatsAppSidecarRequestResponse> {
  switch (request.type) {
    case "send-text":
      return await controller.sendText(request);
    case "ensure-session-group":
      return await controller.ensureSessionGroup(request);
    case "retire-session-group":
      return await controller.retireSessionGroup(request);
    case "send-interaction":
      return await controller.sendInteraction(request);
    case "download-media":
      return await controller.downloadMedia(request);
    case "release-media":
      return await controller.releaseMedia(request);
    case "cancel-interaction":
      return await controller.cancelInteraction(request);
  }
}

class ProcessAuthStoreRpc implements WhatsAppSidecarAuthStorePort {
  private nextRequest = 0;
  private readonly pending = new Map<
    string,
    {
      operation: WhatsAppSidecarAuthRequest["operation"];
      resolve: (response: WhatsAppSidecarAuthResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  private closed = false;

  constructor(private readonly writeFrame: (frame: WhatsAppSidecarChildFrame) => void) {}

  async readCredentials(): Promise<WhatsAppAuthStoreValue | null> {
    const response = await this.request({
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "auth-request",
      requestId: this.requestId(),
      operation: "read-credentials",
    });
    if (response.operation !== "read-credentials" || !response.ok) {
      throw new Error("WhatsApp auth-store RPC returned an unexpected credentials response");
    }
    return response.credentials === null ? null : decodeWhatsAppAuthValue(response.credentials);
  }

  async readSignalKeys(
    category: string,
    ids: readonly string[],
  ): Promise<Record<string, WhatsAppAuthStoreValue>> {
    const response = await this.request({
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "auth-request",
      requestId: this.requestId(),
      operation: "read-signal-keys",
      category,
      ids: [...ids],
    });
    if (response.operation !== "read-signal-keys" || !response.ok) {
      throw new Error("WhatsApp auth-store RPC returned an unexpected Signal-key response");
    }
    return Object.fromEntries(
      Object.entries(response.values).map(([id, value]) => [id, decodeWhatsAppAuthValue(value)]),
    );
  }

  async applyTransaction(update: {
    credentials?: WhatsAppAuthStoreValue | null;
    signalKeys?: Record<string, Record<string, WhatsAppAuthStoreValue | null>>;
  }): Promise<void> {
    const serialized = {
      ...(Object.hasOwn(update, "credentials")
        ? {
            credentials:
              update.credentials === null || update.credentials === undefined
                ? null
                : encodeWhatsAppAuthValue(update.credentials),
          }
        : {}),
      ...(update.signalKeys
        ? {
            signalKeys: Object.fromEntries(
              Object.entries(update.signalKeys).map(([category, entries]) => [
                category,
                Object.fromEntries(
                  Object.entries(entries).map(([id, value]) => [
                    id,
                    value === null ? null : encodeWhatsAppAuthValue(value),
                  ]),
                ),
              ]),
            ),
          }
        : {}),
    };
    const response = await this.request({
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "auth-request",
      requestId: this.requestId(),
      operation: "apply-transaction",
      update: serialized,
    });
    if (response.operation !== "apply-transaction" || !response.ok) {
      throw new Error("WhatsApp auth-store RPC returned an unexpected transaction response");
    }
  }

  async reset(): Promise<void> {
    const response = await this.request({
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "auth-request",
      requestId: this.requestId(),
      operation: "reset",
    });
    if (response.operation !== "reset" || !response.ok) {
      throw new Error("WhatsApp auth-store RPC returned an unexpected reset response");
    }
  }

  accept(response: WhatsAppSidecarAuthResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending || pending.operation !== response.operation) {
      this.close();
      throw new WhatsAppProtocolError("Unexpected WhatsApp auth-store RPC response");
    }
    this.pending.delete(response.requestId);
    if (!response.ok) {
      pending.reject(new Error(`WhatsApp auth-store operation failed (${response.error.code}).`));
      return;
    }
    pending.resolve(response);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("WhatsApp auth-store RPC closed before a response"));
    }
    this.pending.clear();
  }

  private request(request: WhatsAppSidecarAuthRequest): Promise<WhatsAppSidecarAuthResponse> {
    if (this.closed) return Promise.reject(new Error("WhatsApp auth-store RPC is closed"));
    return new Promise((resolve, reject) => {
      this.pending.set(request.requestId, {
        operation: request.operation,
        resolve,
        reject,
      });
      this.writeFrame(request);
    });
  }

  private requestId(): string {
    this.nextRequest += 1;
    return `auth-${this.nextRequest}`;
  }
}

class WhatsAppProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WhatsAppProtocolError";
  }
}

async function executeCommand(
  controller: WhatsAppSocketController,
  command: WhatsAppSidecarCommand,
): Promise<void> {
  switch (command) {
    case "start":
      await controller.start();
      return;
    case "stop":
      await controller.stop();
      return;
    case "reset":
      await controller.resetAndStart();
      return;
    case "provision":
      await controller.provisionManagedGroups();
      return;
    case "shutdown":
      await controller.shutdown();
  }
}

function normalizeCommandError(error: unknown): {
  code: "INVALID_STATE" | "AUTH_STORE_ERROR" | "SOCKET_ERROR" | "INTERNAL_ERROR";
  message: string;
} {
  if (error instanceof WhatsAppSidecarStateError) {
    return { code: "INVALID_STATE", message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "WhatsApp sidecar command failed." };
}
