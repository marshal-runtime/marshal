import {
  ExternalOperationReconciler,
  type ExternalOperationReconcilerOptions,
} from "./reconciler";
import type { ExternalOperationRegistry } from "./registry";

export function createExternalOperationReconciler(
  registry: ExternalOperationRegistry,
  options?: ExternalOperationReconcilerOptions,
): ExternalOperationReconciler {
  return new ExternalOperationReconciler(registry, options);
}
