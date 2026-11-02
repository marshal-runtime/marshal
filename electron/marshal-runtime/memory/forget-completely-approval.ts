import type { IMemoryStore, ISelfToolDeps, MemorySessionScope } from "../../backend/ports";
import { forgetTargetFromList } from "./local-memory-purge";

export const FORGET_COMPLETELY_NEEDS_APPROVAL = "forget completely needs your interactive approval";

/**
 * Tool payload for a provider's coded purge failure, or null for any other
 * error. Both codes mean nothing was purged, so no local copy was touched.
 */
export function forgetCompletelyFailure(error: unknown): Record<string, unknown> | null {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  if (code === "memory_purge_busy") {
    return {
      success: false,
      code,
      error: "Memory is busy; nothing was erased. Try again in a moment.",
    };
  }
  if (code === "memory_not_found") return { success: false, error: "Memory not found" };
  return null;
}

/**
 * The calling session's runtime scope (its workspace and git project), so
 * forget reaches that session's shared memories. Undefined without a
 * resolvable workspace: the provider then reaches only the user's own scope.
 */
export async function forgetSessionScope(
  resolve: ISelfToolDeps["memoryProjectForSession"],
  sessionId: string | undefined,
): Promise<MemorySessionScope | undefined> {
  const project = sessionId ? await resolve?.(sessionId) : undefined;
  if (!project?.workspaceId || !project.projectId) return undefined;
  const { workspaceId, projectId, workspacePath } = project;
  return { workspaceId, projectId, workspacePath };
}

/**
 * Asks the user, on the fixed Allow/Deny permission card, before an
 * irreversible purge. The card is shown even in allow-all sessions and its
 * answer is never remembered, so an "always allow" grant for plain `forget`
 * never covers `completely: true`. Returns a tool error payload, or null when
 * the user approved.
 */
export async function approveForgetCompletely(
  store: IMemoryStore,
  id: string,
  sessionId: string | undefined,
  confirm: ISelfToolDeps["confirmPermissionsEscalation"] | undefined,
  session?: MemorySessionScope,
): Promise<Record<string, unknown> | null> {
  if (!sessionId || typeof confirm !== "function") {
    return {
      success: false,
      code: "interactive_approval_required",
      error: FORGET_COMPLETELY_NEEDS_APPROVAL,
    };
  }
  const target =
    typeof store.forgetTarget === "function"
      ? await store.forgetTarget(id, session)
      : forgetTargetFromList(store, id);
  if (!target) return { success: false, error: "Memory not found" };
  const memoryText =
    target.text ?? "(No text remains; only its content-free history would be erased.)";
  const approved = await confirm(sessionId, { forgetCompletely: { memoryText } });
  if (approved) return null;
  return {
    success: false,
    code: "approval_denied",
    error: "The user did not approve forgetting this memory completely; nothing was erased.",
  };
}
