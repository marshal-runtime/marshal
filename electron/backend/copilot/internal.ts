export {
  APPROVAL_DECISION_TO_RUNTIME,
  RUNTIME_APPROVE_ONCE_PERMISSION_RESULT,
  RUNTIME_RULE_DENY_PERMISSION_RESULT,
  approvalResultToRuntimePermission,
  dynamicProp,
  dynamicString,
  isConnectionLostError,
  log,
} from "../local/internal";
export type {
  ErrorOccurredHookInput,
  LocalClientFactory as CopilotClientFactory,
  LocalClientSubset as CopilotClientSubset,
  LocalSessionSubset as CopilotSessionSubset,
  ILocalProviderForSession as ICopilotProviderForSession,
  ILocalProviderForTools as ICopilotProviderForTools,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SDKModel,
  UserPromptSubmittedHookInput,
} from "../local/internal";
