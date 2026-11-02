import type { PermissionsConfig } from "../../common/marshal-ipc-contract";
import type { AuditDecisionSource } from "../audit-log";
import type { ApprovalRequest } from "../backend/types";
import type { PermissionDecision } from "../permission-policy";
import type { TenantPolicyProvider } from "../tenant-policy";

export type ServerConfig = NonNullable<PermissionsConfig["servers"]>[string];

export type RuleResult = {
  decision: PermissionDecision;
  /**
   * "approved" | "denied" → audit row emitted by dispatcher.
   * undefined → no audit from this rule (user-interactive path logs later).
   */
  auditOutcome: "approved" | "denied" | undefined;
  sdkResult?: string;
};

export interface PolicyContext {
  permissions: PermissionsConfig;
  /** Computed once by dispatcher: effective server config key for this request */
  effectiveServerName: string;
  /** Computed once by dispatcher: permissions.servers[effectiveServerName] */
  serverConfig: ServerConfig | undefined;
  tenantPolicy: TenantPolicyProvider | undefined;
  /** True when the session is in explicit allow-all mode (Autopilot or subagent orchestration). */
  allowAllMode: boolean;
  unattendedSessions: ReadonlySet<string>;
  sessionDenyPrompt: ReadonlySet<string>;
  onDenyPromptCallback: ((sessionId: string, kind: string, detail: string) => void) | undefined;
  /** Resolved workspace directory; when set, SDK read tools outside this path are prompted. */
  workspaceDir?: string;
}

export interface PolicyRule {
  readonly id: string;
  readonly auditSource: AuditDecisionSource;
  apply(request: ApprovalRequest, ctx: PolicyContext): RuleResult | null;
}
