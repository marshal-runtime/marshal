import {
  isHiddenInternalControlMessage,
  type SessionListOptions,
  type SessionSearchResult,
} from "../common/marshal-ipc-contract";
import { resolveSessionRuntimeId } from "../common/runtime-config";
import { sanitizeSessionMetadataForCloudStorage } from "./persistence/cloud-session-sanitizer";
import { redactSecrets } from "./secret-redactor";
import type { SessionsIndex, PersistedSession } from "./session-store";

// ---------------------------------------------------------------------------
// isConditionCheckSession
// ---------------------------------------------------------------------------

/**
 * Condition check sessions are internal bookkeeping -- hide from users.
 * The "workflow" fallback handles sessions persisted before the rename that
 * bypassed migrateSessionFields() (e.g. partial migration or manual edits).
 */
export function isConditionCheckSession(s: {
  source?: string;
  automationId?: string;
  workflowId?: string;
}): boolean {
  return (
    (s.source === "automation" && !s.automationId) || (s.source === "workflow" && !s.workflowId)
  );
}

interface SessionVisibilitySubject {
  source?: string;
  automationId?: string;
  workflowId?: string;
}

type InternalSessionKind = "condition-check" | "workflow-run-host" | "feedback";

function getInternalSessionKind(s: SessionVisibilitySubject): InternalSessionKind | undefined {
  if (isConditionCheckSession(s)) return "condition-check";
  if (s.source === "workflow-run") return "workflow-run-host";
  if (s.source === "feedback") return "feedback";
  return undefined;
}

/**
 * Search and deletion hide every internal session category. Workflow-run hosts
 * are sidebar anchors, but remain internal transcripts that users and tools
 * must not search or delete.
 */
export function isSessionHiddenFromSearchAndDelete(s: SessionVisibilitySubject): boolean {
  return getInternalSessionKind(s) !== undefined;
}

/** List callers must opt in to workflow-run hosts; other internals stay hidden. */
export function isSessionHiddenFromList(
  s: SessionVisibilitySubject,
  includeWorkflowRuns: boolean,
): boolean {
  const kind = getInternalSessionKind(s);
  if (kind === "workflow-run-host") return !includeWorkflowRuns;
  return kind !== undefined;
}

// ---------------------------------------------------------------------------
// searchSessions
// ---------------------------------------------------------------------------

export interface SessionSearchDeps {
  loadIndex: () => SessionsIndex;
  loadSessionDataAsync: (id: string) => Promise<PersistedSession | null>;
  /** Runtime adapter currently selected. Search only returns its sessions. */
  runtimeId: string;
}

/** Search across all session transcripts by keyword. Returns matching sessions with relevant snippets. */
export async function searchSessions(
  deps: SessionSearchDeps,
  query: string,
  maxResults: number = 10,
  options?: Pick<SessionListOptions, "sources" | "excludeSources">,
): Promise<SessionSearchResult[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const index = deps.loadIndex();
  const scored: Array<SessionSearchResult & { score: number }> = [];

  // Limit to most recent 100 user-visible sessions for performance.
  const sessionsToSearch = index.sessions
    .filter((s) => !isSessionHiddenFromSearchAndDelete(s))
    .filter((s) => resolveSessionRuntimeId(s) === deps.runtimeId)
    .filter((s) => !options?.sources || (!!s.source && options.sources.includes(s.source)))
    .filter((s) => !s.source || !options?.excludeSources?.includes(s.source))
    .slice(0, 100);

  // Process in batches to avoid opening too many file handles simultaneously
  const BATCH = 10;
  for (let i = 0; i < sessionsToSearch.length; i += BATCH) {
    const batch = sessionsToSearch.slice(i, i + BATCH);
    // eslint-disable-next-line no-await-in-loop -- sequential pagination
    const batchScored = await Promise.all(
      batch.map(async (meta) => {
        const session = await deps.loadSessionDataAsync(meta.id);
        if (!session || session.messages.length === 0) return null;

        const safeMeta = sanitizeSessionMetadataForCloudStorage(meta).value;
        const snippets: string[] = [];
        let score = 0;

        // Search session name
        if (terms.some((t) => meta.name.toLowerCase().includes(t))) score += 3;

        // Search messages
        for (const msg of session.messages) {
          if (
            isHiddenInternalControlMessage(msg) ||
            msg.goalContinuation ||
            msg.agentMessage?.kind === "readiness" ||
            msg.suppressedAgentStatusResponse
          ) {
            continue;
          }
          const content = typeof msg.content === "string" ? msg.content : "";
          const lower = content.toLowerCase();
          const matchCount = terms.filter((t) => lower.includes(t)).length;
          if (matchCount > 0) {
            score += matchCount;
            // Extract a snippet around the first match
            const firstTerm = terms.find((t) => lower.includes(t))!;
            const idx = lower.indexOf(firstTerm);
            const safeContent = redactSecrets(content).result;
            const safeIndex = Math.min(idx, safeContent.length);
            const start = Math.max(0, safeIndex - 50);
            const end = Math.min(safeContent.length, safeIndex + firstTerm.length + 100);
            const snippet =
              (start > 0 ? "..." : "") +
              safeContent.slice(start, end).trim() +
              (end < safeContent.length ? "..." : "");
            if (snippets.length < 3) {
              snippets.push(`[${msg.role}] ${snippet}`);
            }
          }
        }

        if (score === 0) return null;
        return { ...safeMeta, snippets, score };
      }),
    );

    for (const r of batchScored) {
      if (r) scored.push(r);
    }

    // Early termination: if we have plenty of high-scoring results, stop
    if (scored.length >= maxResults * 3) break;
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ score: _score, ...result }) => result);
}
