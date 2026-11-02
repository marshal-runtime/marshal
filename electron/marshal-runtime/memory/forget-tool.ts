import type { IMemoryStore, ISelfToolDeps } from "../../backend/ports";
import {
  approveForgetCompletely,
  forgetCompletelyFailure,
  forgetSessionScope,
} from "./forget-completely-approval";
import { forgetCompletelyResult } from "./forget-completely-result";
import { FORGET_COMPLETELY_UNSUPPORTED } from "./local-memory-purge";
import { errorMessage } from "./memory-tool-io";

export const FORGET_TOOL_DESCRIPTION =
  "Forget a memory by ID (from recall or listMemories). A plain forget removes it from recall; the result says what history remains. With completely: true it is erased with all its history, including this session's workspace and project memories, after the user approves a card for that one memory.";

export const FORGET_COMPLETELY_DESCRIPTION =
  "IRREVERSIBLE. Permanently erases this memory and all of its history (every earlier revision and correction); it cannot be restored. Reaches your own memories and this session's workspace and project memories; the user approves each one on its own card. Only set this when the user explicitly asks to forget something completely or permanently. Leave it unset for an ordinary forget.";

export interface ForgetToolArgs {
  id: string;
  completely?: boolean;
}

type ForgetToolDeps = Pick<
  ISelfToolDeps,
  "confirmPermissionsEscalation" | "memoryProjectForSession"
>;

/** The host `forget` tool, scoped to the calling session's workspace and project. */
export async function runForgetTool(
  store: IMemoryStore,
  args: ForgetToolArgs,
  sessionId: string | undefined,
  deps: ForgetToolDeps,
): Promise<Record<string, unknown>> {
  const session = await forgetSessionScope(deps.memoryProjectForSession, sessionId);
  if (args.completely !== true) {
    if (typeof store.forgetWithOutcome === "function") {
      const outcome = await store.forgetWithOutcome(args.id, session);
      return outcome
        ? { success: true, ...outcome }
        : { success: false, error: "Memory not found" };
    }
    const deleted = await store.delete(args.id);
    return deleted ? { success: true } : { success: false, error: "Memory not found" };
  }
  if (typeof store.forgetCompletely !== "function") {
    return { success: false, error: FORGET_COMPLETELY_UNSUPPORTED };
  }
  try {
    const refusal = await approveForgetCompletely(
      store,
      args.id,
      sessionId,
      deps.confirmPermissionsEscalation,
      session,
    );
    if (refusal) return refusal;
    const purged = session
      ? await store.forgetCompletely(args.id, session)
      : await store.forgetCompletely(args.id);
    return purged ? forgetCompletelyResult(purged) : { success: false, error: "Memory not found" };
  } catch (error) {
    return forgetCompletelyFailure(error) ?? { success: false, error: errorMessage(error) };
  }
}
