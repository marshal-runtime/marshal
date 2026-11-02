import {
  isOriginalRuntimeAccount,
  parseRuntimeTargetKey,
  runtimeTargetKey,
  type RuntimeTarget,
} from "./runtime-accounts";
import {
  MARSHAL_CLOUD_RUNTIME_ID,
  CLAUDE_RUNTIME_ID,
  CODEX_RUNTIME_ID,
  CURSOR_RUNTIME_ID,
  resolveSessionRuntimeId,
} from "./runtime-config";

export const RUNTIME_MODEL_SEPARATOR = ":";

/** Local runtimes whose clients can run sessions next to the active local runtime. */
export const PEER_RUNTIME_IDS: ReadonlySet<string> = new Set([
  MARSHAL_CLOUD_RUNTIME_ID,
  CLAUDE_RUNTIME_ID,
  CODEX_RUNTIME_ID,
  CURSOR_RUNTIME_ID,
]);

export interface RuntimeQualifiedModel extends RuntimeTarget {
  model: string;
}

/**
 * Splits `<runtime>:<model>` or `<runtime>@<account>:<model>` (for example
 * `cursor:gpt-5.6-luna`, `claude@work:opus`); plain model ids return null.
 */
export function parseRuntimeQualifiedModel(
  model: string | undefined,
): RuntimeQualifiedModel | null {
  if (!model) return null;
  const separator = model.indexOf(RUNTIME_MODEL_SEPARATOR);
  if (separator <= 0) return null;
  const target = parseRuntimeTargetKey(model.slice(0, separator));
  const runtimeModel = model.slice(separator + RUNTIME_MODEL_SEPARATOR.length).trim();
  return target && PEER_RUNTIME_IDS.has(target.runtimeId) && runtimeModel
    ? { ...target, model: runtimeModel }
    : null;
}

export function formatRuntimeQualifiedModel(qualified: RuntimeQualifiedModel): string {
  return `${runtimeTargetKey(qualified)}${RUNTIME_MODEL_SEPARATOR}${qualified.model}`;
}

type ExecutionSession = {
  runtimeId?: string;
  backendOrigin?: "copilot" | "gateway";
  model?: string;
};

/** The runtime that executes a session: the model's runtime qualifier, else the session's runtime. */
export function resolveSessionExecutionRuntimeId(session: ExecutionSession): string {
  return parseRuntimeQualifiedModel(session.model)?.runtimeId ?? resolveSessionRuntimeId(session);
}

/**
 * The runtime and account that execute a session. The original account has no
 * `accountId`, so equal targets compare equal however the model spelled it.
 */
export function resolveSessionExecutionTarget(session: ExecutionSession): RuntimeTarget {
  const qualified = parseRuntimeQualifiedModel(session.model);
  if (!qualified) return { runtimeId: resolveSessionRuntimeId(session) };
  return isOriginalRuntimeAccount(qualified.accountId)
    ? { runtimeId: qualified.runtimeId }
    : { runtimeId: qualified.runtimeId, accountId: qualified.accountId };
}

export function resolveSessionExecutionTargetKey(session: ExecutionSession): string {
  return runtimeTargetKey(resolveSessionExecutionTarget(session));
}
