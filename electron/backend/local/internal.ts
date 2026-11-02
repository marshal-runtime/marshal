import { createLogger } from "../../../common/marshal-logger";
import type {
  RuntimeClient,
  RuntimeClientFactory,
  RuntimeClientSession,
  RuntimeErrorOccurredHookInput,
  RuntimeMcpServerConfig,
  RuntimeModelInfo,
  RuntimePermissionResult,
  RuntimePostToolUseFailureHookInput,
  RuntimePostToolUseHookInput,
  RuntimePreToolUseHookInput,
  RuntimeUserPromptSubmittedHookInput,
} from "../runtime-contract";
import type {
  ApprovalCallback,
  ApprovalDecision,
  ApprovalResult,
  BackendEvent,
  BackendCapabilities,
  IPermissionPolicyProvider,
  ISelfToolDeps,
} from "../types";
import type { PeerRuntimeClients } from "./peer-clients";

export const log = createLogger("LocalBackend");

export const RUNTIME_RULE_DENY_PERMISSION_RESULT = { kind: "user-not-available" as const };
export const RUNTIME_APPROVE_ONCE_PERMISSION_RESULT = { kind: "approve-once" as const };
export const APPROVAL_DECISION_TO_RUNTIME: Record<ApprovalDecision, RuntimePermissionResult> = {
  approved: RUNTIME_APPROVE_ONCE_PERMISSION_RESULT,
  "denied-by-rules": RUNTIME_RULE_DENY_PERMISSION_RESULT,
  "denied-interactively-by-user": { kind: "reject" },
};

/**
 * Translate a Marshal {@link ApprovalResult} into the neutral runtime
 * permission-result vocabulary.
 *
 * The plain string decisions map via {@link APPROVAL_DECISION_TO_SDK}. A
 * `denied-by-policy-with-feedback` carries an actionable reason and maps to the
 * runtime's `reject` result with `feedback`, so the model is told WHY it was
 * blocked (and not to retry/work around it). `user-not-available` stays
 * reserved for genuine no-approver situations.
 */
export function approvalResultToRuntimePermission(result: ApprovalResult): RuntimePermissionResult {
  if (typeof result === "string") {
    return APPROVAL_DECISION_TO_RUNTIME[result];
  }
  return { kind: "reject", feedback: result.feedback };
}

export function dynamicProp(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

export function dynamicString(value: unknown, key: string): string {
  const result = dynamicProp(value, key);
  return typeof result === "string" ? result : "";
}

/** CLI 1.0.69 advertises `max`, while SDK 1.0.6's generated union stops at
 * `xhigh`. Keep the version-skew compatibility projection at this boundary. */
export type SDKModel = RuntimeModelInfo;
export type LocalClientSubset = RuntimeClient;
export type LocalSessionSubset = RuntimeClientSession;
export type LocalClientFactory = RuntimeClientFactory;
export type PreToolUseHookInput = RuntimePreToolUseHookInput;
export type PostToolUseHookInput = RuntimePostToolUseHookInput;
export type PostToolUseFailureHookInput = RuntimePostToolUseFailureHookInput;
export type ErrorOccurredHookInput = RuntimeErrorOccurredHookInput;
export type UserPromptSubmittedHookInput = RuntimeUserPromptSubmittedHookInput;

export function isConnectionLostError(error: unknown): boolean {
  const s = String(error);
  return (
    s.includes("Connection is closed") ||
    s.includes("stream was destroyed") ||
    s.includes("connection got disposed")
  );
}

/**
 * Narrow projection of `LocalBackend` that `LocalSessionBackend` actually
 * uses. Defining the back-pointer as an interface keeps the surface visible
 * here — adding a method on the parent doesn't silently widen what session.ts
 * can reach for.
 */
export interface ILocalProviderForSession {
  capabilities?(): BackendCapabilities;
  getClient(): LocalClientSubset | null;
  initClient(): Promise<void>;
  getWorkspaceDir(): string;
  getMcpConfig(
    overrideWorkspaceDir?: string,
    playwrightHeadless?: boolean,
    sessionId?: string,
  ): Record<string, RuntimeMcpServerConfig>;
  prepareMcpConfig?(
    sessionId: string,
    overrideWorkspaceDir?: string,
    playwrightHeadless?: boolean,
  ): Promise<Record<string, RuntimeMcpServerConfig>>;
  releaseMcpSession?(sessionId: string): Promise<void>;
  getActiveSession(sessionId: string): LocalSessionSubset | undefined;
  setActiveSession(sessionId: string, session: LocalSessionSubset): void;
  deleteActiveSession(sessionId: string): void;
  activeSessionCount(): number;
  activeSessionIds(): string[];
  forceKillActiveRuntime(options?: { interruptedSessionId?: string }): Promise<string[]>;
  getSessionSubscribers(sessionId: string): Set<(event: BackendEvent) => void> | undefined;
  ensureSessionSubscribers(sessionId: string): Set<(event: BackendEvent) => void>;
  deleteSessionSubscribers(sessionId: string): void;
  getApprovalCallback(): ApprovalCallback | null;
  getPermissionPolicy(): IPermissionPolicyProvider | null;
  getSelfToolDeps(): ISelfToolDeps | null;
  getInterceptFileChooser(): boolean;
  getTimezone(): string;
  getRuntimeDisplayName?(): string;
  getRuntimeId?(): string;
  getSessionConfigTraceFilename?(): string;
  getPeerClients?(): PeerRuntimeClients;
}

/** Narrow projection of `LocalBackend` for `LocalToolBackend`. */
export interface ILocalProviderForTools {
  setApprovalCallback(callback: ApprovalCallback): void;
  clearApprovalCallback(): void;
  setApproveAllForActiveSessions(enabled: boolean): Promise<void>;
  listModels(): Promise<SDKModel[]>;
  getCachedModels(): SDKModel[] | null;
}
