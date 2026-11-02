import type {
  ExternalOperationAdapter,
  ExternalOperationAdapterContext,
  ExternalOperationCancelResult,
  ExternalOperationCancellationScope,
  ExternalOperationObservation,
  ExternalOperationProviderKind,
} from "./types";

export interface ExternalOperationHandle {
  inspect(): Promise<ExternalOperationObservation>;
  cancel(
    scope: ExternalOperationCancellationScope,
    cancellationRequestId?: string,
  ): Promise<ExternalOperationCancelResult>;
  adopt?(ownerId: string): Promise<ExternalOperationObservation | void>;
  subscribe?(
    onObservation: (observation: ExternalOperationObservation) => void,
  ): () => void;
}

export type ExternalOperationHandleResolver = (
  context: ExternalOperationAdapterContext,
) => ExternalOperationHandle | null | Promise<ExternalOperationHandle | null>;

export interface HandleBackedExternalOperationAdapterOptions {
  adapterId: string;
  providerKinds: readonly ExternalOperationProviderKind[];
  supportedCancellationScopes: readonly ExternalOperationCancellationScope[];
  resolve: ExternalOperationHandleResolver;
}

export class HandleBackedExternalOperationAdapter implements ExternalOperationAdapter {
  readonly adapterId: string;
  readonly providerKinds: ReadonlySet<ExternalOperationProviderKind>;

  private readonly supportedCancellationScopes: ReadonlySet<ExternalOperationCancellationScope>;
  private readonly resolveHandle: ExternalOperationHandleResolver;

  constructor(options: HandleBackedExternalOperationAdapterOptions) {
    this.adapterId = options.adapterId;
    this.providerKinds = new Set(options.providerKinds);
    this.supportedCancellationScopes = new Set(options.supportedCancellationScopes);
    this.resolveHandle = options.resolve;
  }

  async inspect(context: ExternalOperationAdapterContext): Promise<ExternalOperationObservation> {
    const handle = await this.resolveHandle(context);
    if (!handle) {
      return {
        state: "unknown",
        reason:
          "The durable receipt could not be resolved to a live provider handle; the action was not rerun",
      };
    }
    return await handle.inspect();
  }

  async cancel(
    context: ExternalOperationAdapterContext,
    scope: ExternalOperationCancellationScope,
    _cancellationRequestId?: string,
  ): Promise<ExternalOperationCancelResult> {
    if (!this.supportedCancellationScopes.has(scope)) {
      return {
        accepted: false,
        scope,
        error: `Adapter ${this.adapterId} does not support cancellation scope ${scope}`,
      };
    }
    const handle = await this.resolveHandle(context);
    if (!handle) {
      return {
        accepted: false,
        scope,
        error:
          "The durable receipt could not be resolved to a live provider handle; cancellation responsibility is retained",
      };
    }
    const result = await handle.cancel(scope, _cancellationRequestId);
    return result.scope === scope
      ? result
      : {
          accepted: false,
          scope,
          error: `Adapter ${this.adapterId} acknowledged the wrong cancellation scope ${result.scope}`,
          observation: result.observation,
        };
  }

  async adopt(
    context: ExternalOperationAdapterContext,
    ownerId: string,
  ): Promise<ExternalOperationObservation | void> {
    const handle = await this.resolveHandle(context);
    if (!handle) {
      return {
        state: "unknown",
        reason:
          "The durable receipt could not be adopted by this runtime; the action was not rerun",
      };
    }
    if (handle.adopt) return await handle.adopt(ownerId);
    return await handle.inspect();
  }

  subscribe(
    context: ExternalOperationAdapterContext,
    onObservation: (observation: ExternalOperationObservation) => void,
  ): () => void {
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    void Promise.resolve()
      .then(() => this.resolveHandle(context))
      .then((handle) => {
        if (disposed) return;
        if (!handle) {
          onObservation({
            state: "unknown",
            reason:
              "The durable receipt could not be resolved to a live provider watcher; the action was not rerun",
          });
          return;
        }
        if (handle.subscribe) unsubscribe = handle.subscribe(onObservation);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        onObservation({
          state: "unknown",
          reason: `Provider watcher attachment failed: ${formatError(error)}`,
        });
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }
}

export function createHostManagedBackgroundToolAdapter(
  adapterId: string,
  resolve: ExternalOperationHandleResolver,
): ExternalOperationAdapter {
  return new HandleBackedExternalOperationAdapter({
    adapterId,
    providerKinds: ["host-tool"],
    supportedCancellationScopes: [
      "operation",
      "tool",
      "turn",
      "process",
      "process-group",
      "tree",
      "process-tree",
      "none",
      "provider",
    ],
    resolve,
  });
}

export function createSdkNativeTurnAdapter(
  adapterId: string,
  resolve: ExternalOperationHandleResolver,
): ExternalOperationAdapter {
  return new HandleBackedExternalOperationAdapter({
    adapterId,
    providerKinds: ["sdk-turn"],
    supportedCancellationScopes: ["operation", "turn"],
    resolve,
  });
}

export function createChildProcessAdapter(
  adapterId: string,
  resolve: ExternalOperationHandleResolver,
): ExternalOperationAdapter {
  return new HandleBackedExternalOperationAdapter({
    adapterId,
    providerKinds: ["child-process"],
    supportedCancellationScopes: [
      "operation",
      "process",
      "process-group",
      "tree",
      "process-tree",
    ],
    resolve,
  });
}

export function createSubagentWorkflowAdapter(
  adapterId: string,
  resolve: ExternalOperationHandleResolver,
): ExternalOperationAdapter {
  return new HandleBackedExternalOperationAdapter({
    adapterId,
    providerKinds: ["subagent", "workflow"],
    supportedCancellationScopes: ["operation", "subagent", "workflow"],
    resolve,
  });
}

export function createProviderReceiptAdapter(
  options: HandleBackedExternalOperationAdapterOptions,
): ExternalOperationAdapter {
  return new HandleBackedExternalOperationAdapter(options);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
