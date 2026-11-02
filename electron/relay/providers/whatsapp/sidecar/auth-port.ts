import type { WhatsAppAuthStoreValue, WhatsAppConnectionEvent } from "./protocol";

export interface WhatsAppSidecarAuthStorePort {
  readCredentials(): Promise<WhatsAppAuthStoreValue | null>;
  readSignalKeys(
    category: string,
    ids: readonly string[],
  ): Promise<Record<string, WhatsAppAuthStoreValue>>;
  applyTransaction(update: {
    credentials?: WhatsAppAuthStoreValue | null;
    signalKeys?: Record<string, Record<string, WhatsAppAuthStoreValue | null>>;
  }): Promise<void>;
  reset(): Promise<void>;
}

export type EmitWhatsAppConnectionEvent = (event: WhatsAppConnectionEvent) => void;
