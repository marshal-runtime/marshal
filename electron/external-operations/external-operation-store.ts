import {
  EncryptedExternalOperationPersistence,
  ExternalOperationStore,
  type ExternalOperationPersistence,
} from "./store";

export function createEncryptedExternalOperationPersistence(
  filePath?: string,
): ExternalOperationPersistence {
  return new EncryptedExternalOperationPersistence(filePath);
}

export function createExternalOperationStore(
  persistence: ExternalOperationPersistence,
): ExternalOperationStore {
  return new ExternalOperationStore(persistence);
}
