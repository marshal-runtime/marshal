import {
  WhatsAppSidecarClient,
  type WhatsAppSidecarAuthStore,
  type WhatsAppSidecarLaunchOptions,
} from "./sidecar/client";
import type {
  WhatsAppConnectionEvent,
  WhatsAppSidecarRequest,
  WhatsAppSidecarRequestResponse,
} from "./sidecar/protocol";

interface WhatsAppSidecarControl {
  subscribe(listener: (event: WhatsAppConnectionEvent) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  resetAndStart(): Promise<void>;
  provisionManagedGroups(): Promise<void>;
  sendText(
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
  ensureSessionGroup(
    request: Extract<WhatsAppSidecarRequest, { type: "ensure-session-group" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "ensure-session-group" }>>;
  retireSessionGroup(
    request: Extract<WhatsAppSidecarRequest, { type: "retire-session-group" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "retire-session-group" }>>;
  shutdown(): Promise<void>;
}

type LaunchWhatsAppSidecar = (
  launch: WhatsAppSidecarLaunchOptions,
  authStore: WhatsAppSidecarAuthStore,
) => Promise<WhatsAppSidecarControl>;

export interface WhatsAppConnectionControllerOptions {
  launch: WhatsAppSidecarLaunchOptions;
  authStore: WhatsAppSidecarAuthStore;
  launchSidecar?: LaunchWhatsAppSidecar;
}

export class WhatsAppConnectionController {
  private readonly listeners = new Set<(event: WhatsAppConnectionEvent) => void>();
  private readonly launchSidecar: LaunchWhatsAppSidecar;
  private client: WhatsAppSidecarControl | undefined;
  private unsubscribeClient: (() => void) | undefined;
  private closed = false;
  private operations: Promise<void> = Promise.resolve();

  constructor(private readonly options: WhatsAppConnectionControllerOptions) {
    this.launchSidecar =
      options.launchSidecar ??
      ((launch, authStore) => WhatsAppSidecarClient.launch(launch, authStore));
  }

  subscribe(listener: (event: WhatsAppConnectionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  startPairing(): Promise<void> {
    return this.enqueue(async () => {
      const client = await this.ensureClient();
      await client.start();
    });
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      if (this.client) await this.client.stop();
    });
  }

  resetAndPair(): Promise<void> {
    return this.enqueue(async () => {
      const client = await this.ensureClient();
      await client.resetAndStart();
    });
  }

  retryProvisioning(): Promise<void> {
    return this.enqueue(async () => {
      const client = await this.ensureClient();
      await client.provisionManagedGroups();
    });
  }

  sendText(
    request: Extract<WhatsAppSidecarRequest, { type: "send-text" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-text" }>> {
    return this.enqueue(async () => {
      const client = await this.ensureClient();
      return await client.sendText(request);
    });
  }

  sendInteraction(
    request: Extract<WhatsAppSidecarRequest, { type: "send-interaction" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-interaction" }>> {
    return this.enqueue(async () => {
      const client = await this.ensureClient();
      if (!client.sendInteraction) {
        throw new Error("WhatsApp sidecar does not support interactive prompts");
      }
      return await client.sendInteraction(request);
    });
  }

  downloadMedia(
    request: Extract<WhatsAppSidecarRequest, { type: "download-media" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "download-media" }>> {
    return this.enqueue(async () => {
      const client = await this.ensureClient();
      if (!client.downloadMedia) {
        throw new Error("WhatsApp sidecar does not support media download");
      }
      return await client.downloadMedia(request);
    });
  }

  releaseMedia(
    request: Extract<WhatsAppSidecarRequest, { type: "release-media" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "release-media" }>> {
    return this.enqueue(async () => {
      const client = await this.ensureClient();
      if (!client.releaseMedia) {
        throw new Error("WhatsApp sidecar does not support media release");
      }
      return await client.releaseMedia(request);
    });
  }

  cancelInteraction(
    request: Extract<WhatsAppSidecarRequest, { type: "cancel-interaction" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "cancel-interaction" }>> {
    return this.enqueue(async () => {
      const client = await this.ensureClient();
      if (!client.cancelInteraction) {
        throw new Error("WhatsApp sidecar does not support interaction cancellation");
      }
      return await client.cancelInteraction(request);
    });
  }

  ensureSessionGroup(
    request: Extract<WhatsAppSidecarRequest, { type: "ensure-session-group" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "ensure-session-group" }>> {
    return this.enqueue(async () => {
      const client = await this.ensureClient();
      return await client.ensureSessionGroup(request);
    });
  }

  retireSessionGroup(
    request: Extract<WhatsAppSidecarRequest, { type: "retire-session-group" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "retire-session-group" }>> {
    return this.enqueue(async () => {
      const client = await this.ensureClient();
      return await client.retireSessionGroup(request);
    });
  }

  shutdown(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return;
      this.closed = true;
      this.unsubscribeClient?.();
      this.unsubscribeClient = undefined;
      const client = this.client;
      this.client = undefined;
      if (client) await client.shutdown();
    });
  }

  private async ensureClient(): Promise<WhatsAppSidecarControl> {
    if (this.closed) throw new Error("WhatsApp connection controller is closed");
    if (this.client) return this.client;
    const client = await this.launchSidecar(this.options.launch, this.options.authStore);
    if (this.closed) {
      await client.shutdown();
      throw new Error("WhatsApp connection controller is closed");
    }
    this.client = client;
    const unsubscribe = client.subscribe((event) => {
      if (event.type === "error" && event.code === "SIDECAR_FAILED" && this.client === client) {
        this.client = undefined;
      }
      for (const listener of this.listeners) listener(event);
      if (event.type === "status" && event.status === "stopped" && this.client !== client) {
        this.unsubscribeClient?.();
        this.unsubscribeClient = undefined;
      }
    });
    if (this.client !== client) {
      unsubscribe();
      throw new Error("WhatsApp sidecar failed during launch.");
    }
    this.unsubscribeClient = unsubscribe;
    return client;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
