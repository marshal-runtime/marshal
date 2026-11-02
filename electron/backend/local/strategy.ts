import type { BackendOrigin } from "../../../common/marshal-ipc-contract";
import type { MarshalPromptFiles } from "../ports";
import type { RuntimeAuthLoginRequest, RuntimeClient } from "../runtime-contract";
import type { AuthStatus, BackendCapabilities, LoginResult } from "../types";

export interface LocalRuntimeAuthStrategy {
  augmentStatus?(client: RuntimeClient, status: AuthStatus): Promise<AuthStatus>;
  login?(credentials?: unknown): Promise<LoginResult>;
  logout?(): Promise<void>;
  cancelPendingLogin?(): void;
  clearCachedState?(): void;
}

export interface LocalRuntimeStrategy {
  runtimeId: string;
  origin: BackendOrigin;
  displayName: string;
  sessionConfigTraceFilename: string;
  defaultInferenceModel: string;
  preferredDefaultModelIds: readonly string[];
  accountIdentityPrefix: string;
  capabilities: BackendCapabilities;
  loadWorkspaceFiles(): MarshalPromptFiles | null;
  auth?: LocalRuntimeAuthStrategy;
  defaultClientLoginRequest?: RuntimeAuthLoginRequest;
}
