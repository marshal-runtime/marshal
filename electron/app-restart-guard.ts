export interface RestartGuardSession {
  sessionId: string;
  busy: boolean;
  /** Parent session id for subagent sessions — defines lineage. */
  parentSessionId?: string;
  /** Human-readable label for refusal messages. */
  label?: string;
}

export interface RestartGuardInput {
  requesterSessionId: string;
  force: boolean;
  sessions: RestartGuardSession[];
}

export interface RestartGuardResult {
  allowed: boolean;
  /** Busy sessions outside the requester's lineage — populated even when
   *  force overrides them, so the audit trail names what was overridden. */
  blockingSessions: RestartGuardSession[];
}

/**
 * Safety guard for agent-requested app restarts: a restart is refused when
 * any session OUTSIDE the requester's lineage is busy, unless force is set.
 * Lineage = the requester's ancestor chain plus all of its descendants —
 * those die knowingly with the requester's own restart; unrelated busy
 * sessions (other mains, sibling subagents) must not be killed silently.
 */
export function evaluateRestartGuard(input: RestartGuardInput): RestartGuardResult {
  const byId = new Map(input.sessions.map((session) => [session.sessionId, session]));

  // Ancestors: walk parent chain upward (cycle-safe via the visited set).
  const lineage = new Set<string>([input.requesterSessionId]);
  let cursor = byId.get(input.requesterSessionId);
  while (cursor?.parentSessionId && !lineage.has(cursor.parentSessionId)) {
    lineage.add(cursor.parentSessionId);
    cursor = byId.get(cursor.parentSessionId);
  }
  // Descendants: grow only from the requester's own subtree — NOT from
  // ancestors, or a busy sibling subagent would be silently absorbed.
  const subtree = new Set<string>([input.requesterSessionId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const session of input.sessions) {
      if (
        !subtree.has(session.sessionId) &&
        session.parentSessionId &&
        subtree.has(session.parentSessionId)
      ) {
        subtree.add(session.sessionId);
        grew = true;
      }
    }
  }
  for (const id of subtree) lineage.add(id);

  const blockingSessions = input.sessions.filter(
    (session) => session.busy && !lineage.has(session.sessionId),
  );
  return { allowed: input.force || blockingSessions.length === 0, blockingSessions };
}
