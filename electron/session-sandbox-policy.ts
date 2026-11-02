import type { SessionPermissionMode, SessionSandboxConfig } from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";

const log = createLogger("SessionSandboxPolicy");

/** Runtime guard for sandbox configs that cross a trust boundary (renderer IPC
 *  payloads, stored session rows). The field grants OS-level write access
 *  downstream, so contract typing alone is not enough. */
export function isSessionSandboxConfig(value: unknown): value is SessionSandboxConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!("mode" in value)) return false;
  const { mode } = value;
  if (mode !== "read-only" && mode !== "workspace-write") return false;
  const roots = "writableRoots" in value ? value.writableRoots : undefined;
  if (roots === undefined) return true;
  return Array.isArray(roots) && roots.every((root) => typeof root === "string");
}

/**
 * Validate a session-create sandbox request. Throws on malformed input and on
 * the reviewer invariant: a read-only-reviewer session must never be created
 * with a writable OS sandbox. Ordinary sessions keep explicit overrides
 * (e.g. a validator session granted workspace-write).
 */
export function validateRequestedSandbox(
  sandbox: unknown,
  permissionMode: SessionPermissionMode | undefined,
): SessionSandboxConfig | undefined {
  if (sandbox === undefined || sandbox === null) return undefined;
  if (!isSessionSandboxConfig(sandbox)) {
    throw new Error("Invalid session sandbox config");
  }
  if (permissionMode === "read-only-reviewer" && sandbox.mode !== "read-only") {
    throw new Error("read-only-reviewer sessions cannot use a workspace-write sandbox");
  }
  return sandbox;
}

/**
 * Resolve the sandbox forwarded to the runtime adapter on create AND resume.
 * Stored rows are untrusted here: a reviewer row carrying workspace-write
 * (misconfiguration or tampering) falls back to the adapter default
 * (read-only) instead of arming a writable sandbox. An allow-all session with
 * no explicit sandbox runs without an OS sandbox ("danger-full-access"), the
 * way it does on runtimes that have none; Marshal's permission policy and
 * audit log still see every action. Callers can never request this mode
 * (isSessionSandboxConfig rejects it) — it is derived here, never stored.
 */
export function resolveSessionSandbox(
  // `sandbox` is deliberately loose: stored rows can drift from the contract.
  session: { permissionMode?: SessionPermissionMode; sandbox?: unknown } | null | undefined,
): SessionSandboxConfig | undefined {
  const sandbox = session?.sandbox;
  if (!sandbox) {
    return session?.permissionMode === "allow-all" ? { mode: "danger-full-access" } : undefined;
  }
  if (!isSessionSandboxConfig(sandbox)) {
    log.warn("Dropping malformed stored session sandbox config");
    return undefined;
  }
  if (session?.permissionMode === "read-only-reviewer" && sandbox.mode !== "read-only") {
    log.warn("Dropping workspace-write sandbox stored on a read-only-reviewer session");
    return undefined;
  }
  return sandbox;
}
