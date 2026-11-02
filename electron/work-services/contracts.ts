export type WorkServiceProviderId = string;

export interface NotificationProviderStatus {
  connected: boolean;
  processing: boolean;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface NotificationProvider {
  readonly id: WorkServiceProviderId;
  isAvailable(): boolean;
  getStatus(): NotificationProviderStatus;
  connect(): Promise<void>;
  disconnect(): void;
  send(content: string, sessionId?: string): Promise<void>;
}

export interface WorkServiceProviders {
  readonly notifications: NotificationProvider | null;
}
