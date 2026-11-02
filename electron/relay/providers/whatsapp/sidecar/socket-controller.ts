import type { EmitWhatsAppConnectionEvent, WhatsAppSidecarAuthStorePort } from "./auth-port";
import type {
  WhatsAppConnectedIdentity,
  WhatsAppConnectionEvent,
  WhatsAppDisconnectClassification,
  WhatsAppDisconnectReason,
  WhatsAppInboundManagedMessage,
  WhatsAppSidecarRequest,
  WhatsAppSidecarRequestResponse,
} from "./protocol";
import type { WhatsAppRemoteTopologySnapshot } from "./group-provisioning";
import { describeWhatsAppGroupProvisioningError } from "./group-provisioning";

export type WhatsAppSocketAdapterEvent =
  | {
      type: "connection";
      state: "connecting";
    }
  | {
      type: "connection";
      state: "qr";
      qr: string;
    }
  | {
      type: "connection";
      state: "open";
      identity: WhatsAppConnectedIdentity;
      provisioning?: {
        community: boolean;
        newChats: boolean;
        progress: boolean;
        informationControl: boolean;
      };
      provisioningError?: string;
    }
  | {
      type: "connection";
      state: "close";
      classification: WhatsAppDisconnectClassification;
      reason: WhatsAppDisconnectReason;
      statusCode?: number;
    }
  | {
      type: "auth-error";
    }
  | {
      type: "message";
      message: WhatsAppInboundManagedMessage;
    }
  | {
      type: "interaction-selection";
      selection: Extract<
        WhatsAppConnectionEvent,
        { type: "interaction-selection" }
      >["selection"];
    }
  | {
      type: "message-error";
      message: string;
    };

export interface WhatsAppSocketAdapter {
  close(): Promise<void>;
  inspectManagedTopology?(): Promise<WhatsAppRemoteTopologySnapshot>;
  provisionManagedGroups?(): Promise<void>;
  sendText?(
    request: Extract<WhatsAppSidecarRequest, { type: "send-text" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-text" }>>;
  sendInteraction?(
    request: Extract<WhatsAppSidecarRequest, { type: "send-interaction" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-interaction" }>>;
  downloadMedia?(
    request: Extract<WhatsAppSidecarRequest, { type: "download-media" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "download-media" }>>;
  releaseMedia?(
    request: Extract<WhatsAppSidecarRequest, { type: "release-media" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "release-media" }>>;
  cancelInteraction?(
    request: Extract<WhatsAppSidecarRequest, { type: "cancel-interaction" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "cancel-interaction" }>>;
  ensureSessionGroup?(
    request: Extract<WhatsAppSidecarRequest, { type: "ensure-session-group" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "ensure-session-group" }>>;
  retireSessionGroup?(
    request: Extract<WhatsAppSidecarRequest, { type: "retire-session-group" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "retire-session-group" }>>;
}

export type CreateWhatsAppSocketAdapter = (
  authStore: WhatsAppSidecarAuthStorePort,
  onEvent: (event: WhatsAppSocketAdapterEvent) => void,
) => Promise<WhatsAppSocketAdapter>;

export interface WhatsAppReconnectPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface WhatsAppSocketControllerOptions {
  authStore: WhatsAppSidecarAuthStorePort;
  createSocket: CreateWhatsAppSocketAdapter;
  emitEvent: EmitWhatsAppConnectionEvent;
  reconnectPolicy?: Partial<WhatsAppReconnectPolicy>;
  random?: () => number;
  scheduler?: TimerScheduler;
}

export class WhatsAppSidecarStateError extends Error {
  readonly code = "INVALID_STATE";

  constructor(message: string) {
    super(message);
    this.name = "WhatsAppSidecarStateError";
  }
}

const DEFAULT_RECONNECT_POLICY: WhatsAppReconnectPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
};

const DEFAULT_SCHEDULER: TimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

function describeProvisioningError(error: unknown): string {
  return describeWhatsAppGroupProvisioningError(error);
}

export class WhatsAppSocketController {
  private readonly reconnectPolicy: WhatsAppReconnectPolicy;
  private readonly random: () => number;
  private readonly scheduler: TimerScheduler;
  private adapter: WhatsAppSocketAdapter | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private desiredRunning = false;
  private terminalDisconnect = false;
  private shuttingDown = false;
  private reconnectAttempt = 0;
  private generation = 0;
  private qrSequence = 0;
  private pairingInProgress = false;
  private operations: Promise<void> = Promise.resolve();

  constructor(private readonly options: WhatsAppSocketControllerOptions) {
    this.reconnectPolicy = {
      ...DEFAULT_RECONNECT_POLICY,
      ...options.reconnectPolicy,
    };
    if (
      this.reconnectPolicy.baseDelayMs < 0 ||
      this.reconnectPolicy.maxDelayMs < this.reconnectPolicy.baseDelayMs ||
      this.reconnectPolicy.jitterRatio < 0 ||
      this.reconnectPolicy.jitterRatio > 1
    ) {
      throw new Error("Invalid WhatsApp reconnect policy");
    }
    this.random = options.random ?? Math.random;
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      this.assertNotShuttingDown();
      if (this.terminalDisconnect) {
        throw new WhatsAppSidecarStateError(
          "WhatsApp credentials require an explicit reset before reconnecting.",
        );
      }
      this.desiredRunning = true;
      if (this.adapter || this.reconnectTimer) return;
      this.reconnectAttempt = 0;
      await this.createSocket();
    });
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      this.desiredRunning = false;
      this.cancelReconnect();
      const closeError = await this.closeAdapter();
      this.options.emitEvent({ type: "status", status: "stopped", attempt: 0 });
      if (closeError) throw closeError;
    });
  }

  resetAndStart(): Promise<void> {
    return this.enqueue(async () => {
      this.assertNotShuttingDown();
      this.desiredRunning = false;
      this.cancelReconnect();
      await this.closeAdapter();
      await this.options.authStore.reset();
      this.terminalDisconnect = false;
      this.reconnectAttempt = 0;
      this.pairingInProgress = false;
      this.desiredRunning = true;
      await this.createSocket();
    });
  }

  provisionManagedGroups(): Promise<void> {
    return this.enqueue(async () => {
      this.assertNotShuttingDown();
      if (!this.adapter?.provisionManagedGroups) {
        throw new WhatsAppSidecarStateError(
          "WhatsApp must be connected before managed groups can be provisioned.",
        );
      }
      try {
        await this.adapter.provisionManagedGroups();
        this.options.emitEvent({
          type: "provisioned",
          provisioning: {
            community: true,
            newChats: true,
            progress: true,
            informationControl: true,
          },
        });
      } catch (error) {
        this.options.emitEvent({
          type: "error",
          code: "PROVISIONING_FAILED",
          message: describeProvisioningError(error),
        });
        throw error;
      }
    });
  }

  sendText(
    request: Extract<WhatsAppSidecarRequest, { type: "send-text" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-text" }>> {
    return this.enqueue(async () => {
      this.assertNotShuttingDown();
      if (!this.adapter?.sendText) {
        throw new WhatsAppSidecarStateError(
          "WhatsApp must be connected before a message can be sent.",
        );
      }
      return await this.adapter.sendText(request);
    });
  }

  sendInteraction(
    request: Extract<WhatsAppSidecarRequest, { type: "send-interaction" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-interaction" }>> {
    return this.enqueue(async () => {
      this.assertNotShuttingDown();
      if (!this.adapter?.sendInteraction) {
        throw new WhatsAppSidecarStateError(
          "WhatsApp must be connected before an interactive prompt can be sent.",
        );
      }
      return await this.adapter.sendInteraction(request);
    });
  }

  downloadMedia(
    request: Extract<WhatsAppSidecarRequest, { type: "download-media" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "download-media" }>> {
    return this.enqueue(async () => {
      this.assertNotShuttingDown();
      if (!this.adapter?.downloadMedia) {
        throw new WhatsAppSidecarStateError(
          "WhatsApp media source is no longer available.",
        );
      }
      return await this.adapter.downloadMedia(request);
    });
  }

  releaseMedia(
    request: Extract<WhatsAppSidecarRequest, { type: "release-media" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "release-media" }>> {
    return this.enqueue(async () => {
      this.assertNotShuttingDown();
      if (!this.adapter?.releaseMedia) {
        throw new WhatsAppSidecarStateError(
          "WhatsApp media source is no longer available.",
        );
      }
      return await this.adapter.releaseMedia(request);
    });
  }

  cancelInteraction(
    request: Extract<WhatsAppSidecarRequest, { type: "cancel-interaction" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "cancel-interaction" }>> {
    return this.enqueue(async () => {
      this.assertNotShuttingDown();
      if (!this.adapter?.cancelInteraction) {
        throw new WhatsAppSidecarStateError(
          "WhatsApp interactive prompt is no longer available.",
        );
      }
      return await this.adapter.cancelInteraction(request);
    });
  }

  ensureSessionGroup(
    request: Extract<WhatsAppSidecarRequest, { type: "ensure-session-group" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "ensure-session-group" }>> {
    return this.enqueue(async () => {
      this.assertNotShuttingDown();
      if (!this.adapter?.ensureSessionGroup) {
        throw new WhatsAppSidecarStateError(
          "WhatsApp must be connected before a task group can be created.",
        );
      }
      return await this.adapter.ensureSessionGroup(request);
    });
  }

  retireSessionGroup(
    request: Extract<WhatsAppSidecarRequest, { type: "retire-session-group" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "retire-session-group" }>> {
    return this.enqueue(async () => {
      this.assertNotShuttingDown();
      if (!this.adapter?.retireSessionGroup) {
        throw new WhatsAppSidecarStateError(
          "WhatsApp must be connected before a task group can be retired.",
        );
      }
      return await this.adapter.retireSessionGroup(request);
    });
  }

  shutdown(): Promise<void> {
    return this.enqueue(async () => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      this.desiredRunning = false;
      this.cancelReconnect();
      const closeError = await this.closeAdapter();
      this.options.emitEvent({ type: "status", status: "stopped", attempt: 0 });
      if (closeError) throw closeError;
    });
  }

  private async createSocket(): Promise<void> {
    const generation = ++this.generation;
    const attempt = this.reconnectAttempt;
    this.options.emitEvent({
      type: "status",
      status: attempt === 0 ? "starting" : "connecting",
      attempt,
    });
    try {
      const adapter = await this.options.createSocket(this.options.authStore, (event) => {
        void this.enqueue(() => this.handleAdapterEvent(generation, event));
      });
      if (
        generation !== this.generation ||
        !this.desiredRunning ||
        this.shuttingDown ||
        this.terminalDisconnect
      ) {
        await adapter.close();
        return;
      }
      this.adapter = adapter;
    } catch {
      if (generation === this.generation) {
        this.desiredRunning = false;
        this.options.emitEvent({
          type: "error",
          code: "SOCKET_START_FAILED",
          message: "WhatsApp socket startup failed.",
        });
        this.options.emitEvent({ type: "status", status: "stopped", attempt: 0 });
      }
      throw new WhatsAppSidecarStateError("WhatsApp socket startup failed.");
    }
  }

  private async handleAdapterEvent(
    generation: number,
    event: WhatsAppSocketAdapterEvent,
  ): Promise<void> {
    if (generation !== this.generation || this.shuttingDown) return;
    if (event.type === "auth-error") {
      this.desiredRunning = false;
      this.cancelReconnect();
      await this.closeAdapter();
      this.options.emitEvent({
        type: "error",
        code: "AUTH_PERSISTENCE_FAILED",
        message: "WhatsApp authentication persistence failed.",
      });
      this.options.emitEvent({ type: "status", status: "stopped", attempt: 0 });
      return;
    }
    if (event.type === "message") {
      this.options.emitEvent({ type: "message", message: event.message });
      return;
    }
    if (event.type === "interaction-selection") {
      this.options.emitEvent({
        type: "interaction-selection",
        selection: event.selection,
      });
      return;
    }
    if (event.type === "message-error") {
      this.options.emitEvent({
        type: "error",
        code: "MESSAGE_PROCESSING_FAILED",
        message: event.message,
      });
      return;
    }

    if (event.state === "connecting") {
      this.options.emitEvent({
        type: "status",
        status: "connecting",
        attempt: this.reconnectAttempt,
      });
      return;
    }
    if (event.state === "qr") {
      this.pairingInProgress = true;
      this.qrSequence += 1;
      this.options.emitEvent({
        type: "status",
        status: "awaiting-qr",
        attempt: this.reconnectAttempt,
      });
      this.options.emitEvent({
        type: "setup",
        phase: "qr",
        qr: event.qr,
        sequence: this.qrSequence,
      });
      return;
    }
    if (event.state === "open") {
      this.cancelReconnect();
      this.reconnectAttempt = 0;
      this.options.emitEvent({ type: "status", status: "connected", attempt: 0 });
      if (this.pairingInProgress) {
        this.pairingInProgress = false;
        this.options.emitEvent({ type: "setup", phase: "complete" });
      }
      this.options.emitEvent({ type: "connected", identity: event.identity });
      if (event.provisioning) {
        this.options.emitEvent({ type: "provisioned", provisioning: event.provisioning });
      } else if (event.provisioningError) {
        this.options.emitEvent({
          type: "error",
          code: "PROVISIONING_FAILED",
          message: event.provisioningError,
        });
      }
      return;
    }

    const closeError = await this.closeAdapter();
    if (closeError) {
      this.desiredRunning = false;
      this.cancelReconnect();
      this.options.emitEvent({
        type: "error",
        code: "AUTH_PERSISTENCE_FAILED",
        message: "WhatsApp authentication persistence failed.",
      });
      this.options.emitEvent({ type: "status", status: "stopped", attempt: 0 });
      return;
    }
    if (!this.desiredRunning) return;
    if (event.classification === "terminal") {
      this.desiredRunning = false;
      this.terminalDisconnect = true;
      this.options.emitEvent({
        type: "disconnected",
        classification: "terminal",
        reason: event.reason,
        ...(event.statusCode === undefined ? {} : { statusCode: event.statusCode }),
      });
      this.options.emitEvent({ type: "status", status: "requires-reset", attempt: 0 });
      return;
    }

    this.reconnectAttempt += 1;
    const retryInMs = this.calculateReconnectDelay(this.reconnectAttempt);
    this.options.emitEvent({
      type: "disconnected",
      classification: "retryable",
      reason: event.reason,
      ...(event.statusCode === undefined ? {} : { statusCode: event.statusCode }),
      retryInMs,
    });
    this.options.emitEvent({
      type: "status",
      status: "reconnecting",
      attempt: this.reconnectAttempt,
    });
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.enqueue(async () => {
        if (
          this.desiredRunning &&
          !this.shuttingDown &&
          !this.terminalDisconnect &&
          !this.adapter
        ) {
          await this.createSocket();
        }
      });
    }, retryInMs);
  }

  private calculateReconnectDelay(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    const uncapped = this.reconnectPolicy.baseDelayMs * 2 ** exponent;
    const capped = Math.min(uncapped, this.reconnectPolicy.maxDelayMs);
    const spread = capped * this.reconnectPolicy.jitterRatio;
    return Math.max(0, Math.round(capped - spread + this.random() * spread * 2));
  }

  private cancelReconnect(): void {
    if (!this.reconnectTimer) return;
    this.scheduler.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private async closeAdapter(): Promise<Error | undefined> {
    const adapter = this.adapter;
    this.adapter = undefined;
    this.generation += 1;
    if (!adapter) return undefined;
    try {
      await adapter.close();
      return undefined;
    } catch (error) {
      return error instanceof Error
        ? error
        : new Error("WhatsApp socket adapter failed to close.", { cause: error });
    }
  }

  private assertNotShuttingDown(): void {
    if (this.shuttingDown) {
      throw new WhatsAppSidecarStateError("The WhatsApp sidecar is shutting down.");
    }
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
