import { BACKGROUND_DENY_RULE } from "./marshal-background-deny";
import { DEFAULT_PROMPT_RULE } from "./marshal-default-prompt";
import { FOLDER_GRANT_RULE } from "./folder-grant";
import { KIND_SERVER_FALLBACK_RULE } from "./marshal-kind-server-fallback";
import { PATTERN_WHITELIST_RULE } from "./configured-pattern-whitelist-rule";
import { READ_AUTO_APPROVE_RULE } from "./read-tool-auto-approval-rule";
import { READ_ONLY_AUTO_APPROVE_RULE } from "./read-only-tool-auto-approval-rule";
import { REMOTE_AUTH_VECTOR_RULE } from "./remote-authentication-vector-rule";
import { SENSITIVE_PATH_GATE_RULE } from "./sensitive-path-access-gate-rule";
import { SERVER_AUTO_APPROVE_RULE } from "./configured-server-auto-approval-rule";
import { SERVER_DISABLED_RULE } from "./marshal-server-disabled";
import { SHELL_DENY_PATTERN_RULE } from "./shell-deny-pattern-rule";
import { STRUCTURED_TOOL_AUTO_APPROVE_RULE } from "./structured-tool-auto-approval-rule";
import { TENANT_DENY_RULE } from "./marshal-tenant-deny";
import { TENANT_FORCE_PROMPT_RULE } from "./marshal-tenant-force-prompt";
import type { PolicyRule } from "./types";

export const POLICY_RULES: readonly PolicyRule[] = [
  TENANT_DENY_RULE,
  TENANT_FORCE_PROMPT_RULE,
  SENSITIVE_PATH_GATE_RULE,
  READ_AUTO_APPROVE_RULE,
  SERVER_DISABLED_RULE,
  FOLDER_GRANT_RULE,
  REMOTE_AUTH_VECTOR_RULE,
  SERVER_AUTO_APPROVE_RULE,
  KIND_SERVER_FALLBACK_RULE,
  READ_ONLY_AUTO_APPROVE_RULE,
  SHELL_DENY_PATTERN_RULE,
  STRUCTURED_TOOL_AUTO_APPROVE_RULE,
  PATTERN_WHITELIST_RULE,
  BACKGROUND_DENY_RULE,
  DEFAULT_PROMPT_RULE,
];
