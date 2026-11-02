import { MARSHAL_RELAY_WORK_SERVICE_PROVIDER_ID } from "../../common/provider-config";
import type { NotificationProvider } from "./contracts";

/**
 * Provider-neutral transport surface a relay must expose to back the
 * notifications work service. Any relay provider (WhatsApp today) can satisfy
 * it; nothing here is specific to a single vendor.
 */
export interface NotificationRelayPort {
  readonly processing: boolean;
  readonly displaced: boolean;
  isConnected(): boolean;
  connect(): Promise<void>;
  disconnect(): void;
}

export interface RelayNotificationAdapterDeps {
  relay: NotificationRelayPort;
  isAvailable: () => boolean;
  send: (content: string, sessionId?: string) => Promise<void>;
}

export class RelayNotificationServiceProvider implements NotificationProvider {
  readonly id = MARSHAL_RELAY_WORK_SERVICE_PROVIDER_ID;

  constructor(private readonly deps: RelayNotificationAdapterDeps) {}

  isAvailable(): boolean {
    return this.deps.isAvailable();
  }

  getStatus() {
    return {
      connected: this.deps.relay.isConnected(),
      processing: this.deps.relay.processing,
      metadata: { displaced: this.deps.relay.displaced },
    };
  }

  connect(): Promise<void> {
    return this.deps.relay.connect();
  }

  disconnect(): void {
    this.deps.relay.disconnect();
  }

  send(content: string, sessionId?: string): Promise<void> {
    return this.deps.send(content, sessionId);
  }
}
