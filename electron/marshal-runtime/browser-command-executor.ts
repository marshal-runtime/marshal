import type { ResolvedMarshalRuntimeScope } from "./contracts";

export interface MarshalRuntimeBrowserRequestContext {
  readonly chatId: string;
  readonly executionId: string;
  readonly browserSessionId: string;
}

export interface MarshalRuntimeBrowserCommandResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
  readonly metadata?: {
    readonly duration: number;
    readonly timestamp: number;
    readonly commandId?: string;
    readonly context?: MarshalRuntimeBrowserRequestContext;
  };
}

export interface MarshalRuntimeBrowserCommandRequest {
  readonly command: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly context: MarshalRuntimeBrowserRequestContext;
  readonly scope: ResolvedMarshalRuntimeScope;
  readonly signal?: AbortSignal;
}

export interface MarshalRuntimeBrowserCommandExecutorPort {
  execute(
    request: MarshalRuntimeBrowserCommandRequest,
  ): Promise<MarshalRuntimeBrowserCommandResult>;
  dispose(): Promise<void>;
}
