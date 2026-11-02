import type { RuntimeSearchResponse } from "@marshal/runtime";
import type { CapabilityInvocationResult } from "@marshal/runtime";
import type {
  RuntimeExtensionIntegrity,
  RuntimeExtensionRecord,
} from "@marshal/runtime/extensions";

import type {
  MemoryCategory,
  MemoryEntry,
  ReasoningEffort,
  SessionMetadata,
  SessionRuntimeAgentRole,
  SessionSource,
} from "./marshal-ipc-contract";
import type { RuntimeUiResult } from "./runtime-ui";

export type RuntimeAcceptanceResult<T> =
  | { readonly success: true; readonly value: T }
  | {
      readonly success: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    };

export type RuntimeAcceptanceToken = string;

export interface RuntimeAcceptanceScope {
  readonly sessionId: string;
  readonly workspaceName: string;
}

export type RuntimeAcceptanceAbort =
  | { readonly timing: "none" }
  | { readonly timing: "pre" }
  | { readonly timing: "after-ms"; readonly delayMs: number }
  | {
      readonly timing: "fixture-event";
      readonly event: "activate:start" | "activate:complete" | "invoke:start";
    };

export type RuntimeAcceptanceLaunchProfile =
  | "default"
  | "pre-ready-quit"
  | "disposal-aggregation"
  | "startup-delay"
  | "runtime-startup-failure";

export interface RuntimeAcceptanceBridgeInfo {
  readonly compileTimeGate: true;
  readonly runtimeGates: {
    readonly unpackaged: true;
    readonly marshalE2E: true;
    readonly runtimeAcceptance: true;
    readonly tokenAuthenticated: true;
  };
  readonly mainProcessPid: number;
  readonly preloadIdentity: "runtime-acceptance-preload.cjs";
  readonly nodeExecutable: string;
  readonly backendIdentity: {
    readonly runtimeId: string;
    readonly origin: "copilot" | "gateway";
  };
  readonly instanceIds: {
    readonly host: string;
    readonly api: string;
    readonly kernel: string | null;
    readonly extensionManager: string | null;
    readonly uiController: string;
    readonly sessionManager: string;
    readonly memoryManager: string;
    readonly authority: string;
  };
  readonly instanceCounts: {
    readonly host: number;
    readonly api: number;
    readonly kernel: number;
    readonly extensionManager: number;
    readonly uiController: number;
    readonly sessionManager: number;
    readonly memoryManager: number;
  };
}

export interface RuntimeAcceptancePaths {
  readonly runRoot: string;
  readonly evidenceRoot: string;
  readonly electronUserDataRoot: string;
  readonly marshalAppDataRoot: string;
  readonly runtimeRoot: string;
  readonly workspaceRoot: string;
  readonly protectedResultsRoot: string;
  readonly worktreeRoot: string;
  readonly trustedExtensionRoot: string;
}

export interface RuntimeAcceptanceLifecycleEvent {
  readonly timestamp: string;
  readonly type: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface RuntimeAcceptanceAuthorityAuditEntry {
  readonly timestamp: string;
  readonly sessionId: string;
  readonly workspaceName: string;
  readonly capability: string;
  readonly permissions: readonly string[];
  readonly decision: "allow" | "approval" | "deny";
  readonly reason?: string;
  readonly code?: string;
}

export interface RuntimeAcceptanceSelfToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly supportsAbortSignal: boolean;
  readonly objectId: string;
}

export interface RuntimeAcceptanceSelfToolRequest {
  readonly name: string;
  readonly sessionId: string;
  readonly arguments?: unknown;
  readonly toolCallId: string;
  readonly abort?: RuntimeAcceptanceAbort;
}

export interface RuntimeAcceptanceSearchRequest extends RuntimeAcceptanceScope {
  readonly query?: string;
  readonly name?: string;
  readonly detail?: "summary" | "full";
  readonly tags?: readonly string[];
  readonly limit?: number;
  readonly abort?: RuntimeAcceptanceAbort;
}

export interface RuntimeAcceptanceInvokeRequest extends RuntimeAcceptanceScope {
  readonly capability: string;
  readonly input?: unknown;
  readonly idempotencyKey: string;
  readonly abort?: RuntimeAcceptanceAbort;
}

export type RuntimeAcceptanceTypeScriptProfile =
  | "source-empty"
  | "source-whitespace"
  | "source-at-limit"
  | "invoke-capability"
  | "search-capability"
  | "ambient-fs"
  | "ambient-child-process"
  | "ambient-process"
  | "undeclared-import"
  | "source-over-limit"
  | "timeout"
  | "output-overflow";

export type RuntimeAcceptancePackageRootVariant =
  | "fixture"
  | "empty"
  | "whitespace"
  | "at-limit"
  | "over-limit";

export interface RuntimeAcceptanceTypeScriptRequest extends RuntimeAcceptanceScope {
  readonly profile: RuntimeAcceptanceTypeScriptProfile;
  readonly capability?: string;
  readonly input?: unknown;
  readonly timeoutMs?: number;
  readonly idempotencyKey: string;
  readonly abort?: RuntimeAcceptanceAbort;
}

export interface RuntimeAcceptanceResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface RuntimeAcceptanceResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

export interface RuntimeAcceptanceResourceListRequest extends RuntimeAcceptanceScope {
  readonly abort?: RuntimeAcceptanceAbort;
}

export interface RuntimeAcceptanceResourceReadRequest extends RuntimeAcceptanceScope {
  readonly uri: string;
  readonly abort?: RuntimeAcceptanceAbort;
}

export interface RuntimeAcceptanceExtensionListRequest extends RuntimeAcceptanceScope {
  readonly abort?: RuntimeAcceptanceAbort;
}

export interface RuntimeAcceptanceExtensionInstallRequest extends RuntimeAcceptanceScope {
  readonly fixtureId: string;
  readonly packageRootVariant?: RuntimeAcceptancePackageRootVariant;
  readonly idempotencyKey: string;
  readonly abort?: RuntimeAcceptanceAbort;
}

export interface RuntimeAcceptanceExtensionUpdateRequest extends RuntimeAcceptanceExtensionInstallRequest {
  readonly identity: string;
}

export interface RuntimeAcceptanceExtensionStateRequest extends RuntimeAcceptanceScope {
  readonly identity: string;
  readonly idempotencyKey: string;
  readonly abort?: RuntimeAcceptanceAbort;
}

export type RuntimeAcceptanceFixtureProfile =
  | "echo"
  | "invocation-delay"
  | "activation-delay"
  | "activation-failure"
  | "disposal-failure"
  | "multi-contribution"
  | "duplicate-capability"
  | "duplicate-resource"
  | "unsupported-import"
  | "strict-manifest"
  | "unknown-permission"
  | "ui-application"
  | "file-count-limit"
  | "file-size-limit"
  | "tree-size-limit"
  | "collision";

export type RuntimeAcceptanceCollisionKind =
  | "provider"
  | "catalog-provider"
  | "catalog-entry"
  | "capability"
  | "resource";

export interface RuntimeAcceptanceFixtureSpec {
  readonly profile: RuntimeAcceptanceFixtureProfile;
  readonly version?: string;
  readonly identity?: string;
  readonly identityFixtureId?: string;
  readonly activationDelayMs?: number;
  readonly invocationDelayMs?: number;
  readonly fileCount?: number;
  readonly fileSizeBytes?: number;
  readonly treeSizeBytes?: number;
  readonly uiApplicationId?: string;
  readonly collisionFixtureId?: string;
  readonly collisionKind?: RuntimeAcceptanceCollisionKind;
  readonly location?: "trusted" | "outside-root";
}

export type RuntimeAcceptanceFixtureMutation =
  | "post-hash-mutation"
  | "wrong-digest"
  | "invalid-integrity-descriptor"
  | "add-unexpected-file"
  | "delete-entrypoint"
  | "source-unavailable"
  | "manifest-identity"
  | "manifest-version"
  | "manifest-extra-key"
  | "manifest-missing-key"
  | "manifest-missing-entrypoint"
  | "manifest-unsupported-format"
  | "manifest-invalid-utf8"
  | "manifest-oversized"
  | "unsafe-entrypoint"
  | "reserved-entrypoint"
  | "non-cjs-entrypoint"
  | "package-type-mismatch"
  | "package-main-mismatch"
  | "unsupported-import"
  | "module-load-throw"
  | "missing-activate"
  | "activation-failure"
  | "duplicate-capability"
  | "duplicate-resource"
  | "case-colliding-paths"
  | "trailing-dot-path"
  | "tree-escape"
  | "symlink-entrypoint"
  | "symlink-root";

export interface RuntimeAcceptanceFixtureMutationSpec {
  readonly fixtureId: string;
  readonly mutation: RuntimeAcceptanceFixtureMutation;
}

export interface RuntimeAcceptanceFixture {
  readonly fixtureId: string;
  readonly packageRoot: string;
  readonly integrity: RuntimeExtensionIntegrity;
  readonly identity: string;
  readonly version: string;
  readonly capabilityNames: readonly string[];
  readonly providerIds: readonly string[];
  readonly catalogProviderIds: readonly string[];
  readonly catalogIds: readonly string[];
  readonly resourceUris: readonly string[];
  readonly uiApplicationIds: readonly string[];
}

export interface RuntimeAcceptanceMemoryEntry {
  readonly id: string;
  readonly fact: string;
  readonly category: "preference" | "fact" | "decision" | "context";
  readonly source: string;
  readonly createdAt: string;
  readonly lastAccessedAt: string;
  readonly accessCount: number;
}

export type RuntimeAcceptanceFixtureRequest =
  | {
      readonly action: "create-agent";
      readonly parentSessionId: string;
      readonly source: Extract<SessionSource, "subagent" | "workflow-agent">;
      readonly workspaceName?: string;
      readonly name?: string;
      readonly runtimeAgentRole?: SessionRuntimeAgentRole;
      readonly model?: string;
      readonly reasoningEffort?: ReasoningEffort;
    }
  | {
      readonly action: "append-hidden-message";
      readonly sessionId: string;
      readonly content: string;
    }
  | {
      readonly action: "set-session-workspace";
      readonly sessionId: string;
      readonly workspaceName?: string;
    }
  | {
      readonly action: "seed-memory";
      readonly fact: string;
      readonly category?: MemoryCategory;
      readonly source: string;
    }
  | {
      readonly action: "seed-raw-memory";
      readonly fact: string;
      readonly sessionId: string;
      readonly workspaceName: string;
    }
  | {
      readonly action: "recall-memory-backing";
      readonly query: string;
      readonly limit: number;
    }
  | {
      readonly action: "configure-memory-backing";
      readonly control: {
        readonly addFailure?: string;
        readonly recallFailure?: string;
        readonly recallDelayMs?: number;
      } | null;
    }
  | {
      readonly action: "diagnostics";
      readonly target: "agent" | "memory" | "memory-notifications";
    }
  | {
      readonly action: "agent-outbox";
      readonly state: "started" | "stopped";
    }
  | {
      readonly action: "validate-agent-role";
      readonly role?: string;
    }
  | {
      readonly action: "load-persisted-agent-role-fixtures";
    }
  | {
      readonly action: "ui-chat-persistence-gate";
      readonly command: "arm" | "wait" | "release";
    };

export type RuntimeAcceptanceFixtureResult =
  | {
      readonly action: "create-agent";
      readonly session: SessionMetadata;
    }
  | {
      readonly action: "append-hidden-message";
      readonly appended: boolean;
    }
  | {
      readonly action: "set-session-workspace";
      readonly before?: string;
      readonly after?: string;
    }
  | {
      readonly action: "seed-memory";
      readonly entry: MemoryEntry | null;
    }
  | {
      readonly action: "seed-raw-memory";
      readonly entry: MemoryEntry;
    }
  | {
      readonly action: "recall-memory-backing";
      readonly entries: readonly MemoryEntry[];
    }
  | {
      readonly action: "configure-memory-backing";
      readonly diagnostics: Readonly<Record<string, number>>;
    }
  | {
      readonly action: "diagnostics";
      readonly target: "agent" | "memory" | "memory-notifications";
      readonly diagnostics: Readonly<Record<string, number>>;
    }
  | {
      readonly action: "agent-outbox";
      readonly state: "started" | "stopped";
    }
  | {
      readonly action: "validate-agent-role";
      readonly valid: boolean;
    }
  | {
      readonly action: "load-persisted-agent-role-fixtures";
      readonly invalidGeneric: {
        readonly id: string;
        readonly loaded: boolean;
      };
      readonly absentRole: {
        readonly id: string;
        readonly loaded: boolean;
        readonly runtimeAgentRole?: SessionRuntimeAgentRole;
      };
    }
  | {
      readonly action: "ui-chat-persistence-gate";
      readonly state: "armed" | "reached" | "released";
    };

export type RuntimeAcceptancePermissionDecision = "allow" | "prompt" | "deny";

export interface RuntimeAcceptanceRegistrationInventory {
  readonly scope: RuntimeAcceptanceScope;
  readonly search: RuntimeSearchResponse;
  readonly extensions: readonly RuntimeExtensionRecord[];
  readonly resources: readonly RuntimeAcceptanceResourceDescriptor[];
  readonly selfTools: readonly RuntimeAcceptanceSelfToolDescriptor[];
}

export interface RuntimeAcceptanceInvocationCounts {
  readonly bridgeOperations: Readonly<Record<string, number>>;
  readonly fixtureEvents: Readonly<Record<string, readonly string[]>>;
  readonly ordinaryToolListings: Readonly<
    Record<string, { readonly objectId: string; readonly count: number }>
  >;
  readonly ordinaryToolInvocations: Readonly<
    Record<string, { readonly objectId: string; readonly count: number }>
  >;
  readonly uiNotifications: readonly {
    readonly sessionId: string;
    readonly titleSha256: string;
    readonly titleLength: number;
    readonly bodySha256: string;
    readonly bodyLength: number;
  }[];
  readonly generatedTypeScriptSources: readonly {
    readonly profile: RuntimeAcceptanceTypeScriptProfile;
    readonly capability?: string;
    readonly idempotencyKey: string;
    readonly sourceSha256: string;
    readonly sourceLength: number;
  }[];
}

export type RuntimeAcceptanceUiProbeOperation =
  | "open"
  | "prototype-pollution"
  | "update"
  | "focus"
  | "close"
  | "list"
  | "snapshot"
  | "notification"
  | "chat-message"
  | "chat-card";

export interface RuntimeAcceptanceUiProbeRequest extends RuntimeAcceptanceScope {
  readonly operation: RuntimeAcceptanceUiProbeOperation;
  readonly extensionId: string;
  readonly applicationId: string;
  readonly instanceId?: string;
  readonly idempotencyKey: string;
  readonly abort?: RuntimeAcceptanceAbort;
}

export type RuntimeAcceptanceApiResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly receipts: readonly unknown[];
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
      readonly receipts: readonly unknown[];
    };

export interface RuntimeAcceptanceInvocationValue {
  readonly output: unknown;
  readonly result: CapabilityInvocationResult;
}

export interface RuntimeAcceptanceHostStatus {
  readonly lifecycle: "stopped" | "starting" | "running" | "disposing" | "disposed" | "failed";
  readonly runtimePackage: {
    readonly name: "@marshal/runtime";
    readonly version: string;
    readonly entrypoint: string;
    readonly entrySha256: string;
  };
}

export interface RuntimeAcceptanceIpcInvokeMap {
  "runtime-acceptance:getBridgeInfo": (
    token: RuntimeAcceptanceToken,
  ) => Promise<RuntimeAcceptanceResult<RuntimeAcceptanceBridgeInfo>>;
  "runtime-acceptance:getStatus": (
    token: RuntimeAcceptanceToken,
  ) => Promise<RuntimeAcceptanceResult<RuntimeAcceptanceHostStatus>>;
  "runtime-acceptance:getStartupError": (
    token: RuntimeAcceptanceToken,
  ) => Promise<RuntimeAcceptanceResult<{ readonly code: string; readonly message: string } | null>>;
  "runtime-acceptance:getPaths": (
    token: RuntimeAcceptanceToken,
  ) => Promise<RuntimeAcceptanceResult<RuntimeAcceptancePaths>>;
  "runtime-acceptance:getLifecycleEvents": (
    token: RuntimeAcceptanceToken,
  ) => Promise<RuntimeAcceptanceResult<readonly RuntimeAcceptanceLifecycleEvent[]>>;
  "runtime-acceptance:listRegisteredSelfTools": (
    token: RuntimeAcceptanceToken,
  ) => Promise<RuntimeAcceptanceResult<readonly RuntimeAcceptanceSelfToolDescriptor[]>>;
  "runtime-acceptance:listOrdinarySelfTools": (
    token: RuntimeAcceptanceToken,
    sessionId: string,
  ) => Promise<RuntimeAcceptanceResult<readonly RuntimeAcceptanceSelfToolDescriptor[]>>;
  "runtime-acceptance:invokeRegisteredSelfTool": (
    token: RuntimeAcceptanceToken,
    request: RuntimeAcceptanceSelfToolRequest,
  ) => Promise<RuntimeAcceptanceResult<string>>;
  "runtime-acceptance:search": (
    token: RuntimeAcceptanceToken,
    request: RuntimeAcceptanceSearchRequest,
  ) => Promise<RuntimeAcceptanceResult<RuntimeAcceptanceApiResult<RuntimeSearchResponse>>>;
  "runtime-acceptance:invoke": (
    token: RuntimeAcceptanceToken,
    request: RuntimeAcceptanceInvokeRequest,
  ) => Promise<
    RuntimeAcceptanceResult<RuntimeAcceptanceApiResult<RuntimeAcceptanceInvocationValue>>
  >;
  "runtime-acceptance:executeTypeScript": (
    token: RuntimeAcceptanceToken,
    request: RuntimeAcceptanceTypeScriptRequest,
  ) => Promise<
    RuntimeAcceptanceResult<RuntimeAcceptanceApiResult<RuntimeAcceptanceInvocationValue>>
  >;
  "runtime-acceptance:listResources": (
    token: RuntimeAcceptanceToken,
    request: RuntimeAcceptanceResourceListRequest,
  ) => Promise<RuntimeAcceptanceResult<readonly RuntimeAcceptanceResourceDescriptor[]>>;
  "runtime-acceptance:readResource": (
    token: RuntimeAcceptanceToken,
    request: RuntimeAcceptanceResourceReadRequest,
  ) => Promise<RuntimeAcceptanceResult<RuntimeAcceptanceResourceContent>>;
  "runtime-acceptance:listExtensions": (
    token: RuntimeAcceptanceToken,
    request: RuntimeAcceptanceExtensionListRequest,
  ) => Promise<
    RuntimeAcceptanceResult<RuntimeAcceptanceApiResult<readonly RuntimeExtensionRecord[]>>
  >;
  "runtime-acceptance:installExtension": (
    token: RuntimeAcceptanceToken,
    request: RuntimeAcceptanceExtensionInstallRequest,
  ) => Promise<RuntimeAcceptanceResult<RuntimeAcceptanceApiResult<RuntimeExtensionRecord>>>;
  "runtime-acceptance:updateExtension": (
    token: RuntimeAcceptanceToken,
    request: RuntimeAcceptanceExtensionUpdateRequest,
  ) => Promise<RuntimeAcceptanceResult<RuntimeAcceptanceApiResult<RuntimeExtensionRecord>>>;
  "runtime-acceptance:enableExtension": (
    token: RuntimeAcceptanceToken,
    request: RuntimeAcceptanceExtensionStateRequest,
  ) => Promise<RuntimeAcceptanceResult<RuntimeAcceptanceApiResult<RuntimeExtensionRecord>>>;
  "runtime-acceptance:disableExtension": (
    token: RuntimeAcceptanceToken,
    request: RuntimeAcceptanceExtensionStateRequest,
  ) => Promise<RuntimeAcceptanceResult<RuntimeAcceptanceApiResult<RuntimeExtensionRecord>>>;
  "runtime-acceptance:removeExtension": (
    token: RuntimeAcceptanceToken,
    request: RuntimeAcceptanceExtensionStateRequest,
  ) => Promise<
    RuntimeAcceptanceResult<
      RuntimeAcceptanceApiResult<{ readonly identity: string; readonly removed: true }>
    >
  >;
  "runtime-acceptance:materializeExtensionFixture": (
    token: RuntimeAcceptanceToken,
    spec: RuntimeAcceptanceFixtureSpec,
  ) => Promise<RuntimeAcceptanceResult<RuntimeAcceptanceFixture>>;
  "runtime-acceptance:mutateExtensionFixture": (
    token: RuntimeAcceptanceToken,
    spec: RuntimeAcceptanceFixtureMutationSpec,
  ) => Promise<RuntimeAcceptanceResult<RuntimeAcceptanceFixture>>;
  "runtime-acceptance:readSession": (
    token: RuntimeAcceptanceToken,
    sessionId: string,
  ) => Promise<RuntimeAcceptanceResult<Readonly<Record<string, unknown>> | null>>;
  "runtime-acceptance:readMemories": (
    token: RuntimeAcceptanceToken,
  ) => Promise<RuntimeAcceptanceResult<readonly RuntimeAcceptanceMemoryEntry[]>>;
  "runtime-acceptance:setAcceptancePermission": (
    token: RuntimeAcceptanceToken,
    permission: string,
    decision: RuntimeAcceptancePermissionDecision,
  ) => Promise<RuntimeAcceptanceResult<{ readonly permission: string; readonly decision: string }>>;
  "runtime-acceptance:getAuthorityAudit": (
    token: RuntimeAcceptanceToken,
  ) => Promise<RuntimeAcceptanceResult<readonly RuntimeAcceptanceAuthorityAuditEntry[]>>;
  "runtime-acceptance:getRegistrationInventory": (
    token: RuntimeAcceptanceToken,
  ) => Promise<RuntimeAcceptanceResult<RuntimeAcceptanceRegistrationInventory>>;
  "runtime-acceptance:getInvocationCounts": (
    token: RuntimeAcceptanceToken,
  ) => Promise<RuntimeAcceptanceResult<RuntimeAcceptanceInvocationCounts>>;
  "runtime-acceptance:probeRuntimeUiOperation": (
    token: RuntimeAcceptanceToken,
    request: RuntimeAcceptanceUiProbeRequest,
  ) => Promise<RuntimeAcceptanceResult<RuntimeUiResult<unknown>>>;
  "runtime-acceptance:fixture": (
    token: RuntimeAcceptanceToken,
    request: RuntimeAcceptanceFixtureRequest,
  ) => Promise<RuntimeAcceptanceResult<RuntimeAcceptanceFixtureResult>>;
}

type RuntimeAcceptanceMethodName<K extends keyof RuntimeAcceptanceIpcInvokeMap> =
  K extends `runtime-acceptance:${infer Method}` ? Method : never;

type WithoutAcceptanceToken<T> = T extends (
  token: RuntimeAcceptanceToken,
  ...args: infer Args
) => infer Result
  ? (...args: Args) => Result
  : never;

export type RuntimeAcceptanceAPI = {
  [K in keyof RuntimeAcceptanceIpcInvokeMap as RuntimeAcceptanceMethodName<K>]: WithoutAcceptanceToken<
    RuntimeAcceptanceIpcInvokeMap[K]
  >;
};
