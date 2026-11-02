/**
 * The calling session's runtime scope (`workspaceId`/`projectId` as the
 * Marshal Runtime scopes that session). With it a provider also reaches the
 * session's shared workspace and project memories; without it, only the
 * user's own scope.
 */
export interface MemorySessionScope {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly workspacePath?: string;
}

/**
 * Result of `IMemoryStore.forgetCompletely`. `purgedFacts` is memory content:
 * it is only used to match local copies and never reaches logs or tool output.
 */
export interface MemoryPurgeResult {
  readonly memoryId: string;
  /** Every purged revision id, including the requested one. */
  readonly purgedIds: readonly string[];
  /** Text of every purged revision, older corrected ones included, so callers can purge copies. */
  readonly purgedFacts?: readonly string[];
  /** Where the memory was: the user's own scope, or the session's workspace or project. */
  readonly scopeKind?: "user" | "workspace" | "project";
  /** Whether index slots that held a purged revision's text have been compacted yet. */
  readonly compaction?: "pending" | "done";
  readonly pendingSlots?: readonly string[];
  /** Cached lifecycle results (recalled memory text) deleted right after the purge. */
  readonly lifecycleResults?: { readonly available: boolean; readonly removed: number };
  /** Promotion copies in scopes the caller may not purge: not purged. */
  readonly skippedIds?: readonly string[];
  readonly removedProjections?: number;
  /** Index removals that failed now and wait in the index backlog. */
  readonly indexRemovalsPending?: number;
  /** The database file was rewritten, so free pages no longer hold the purged text. */
  readonly vacuumed?: boolean;
  /** False when old page images may remain in the write-ahead log for now. */
  readonly walTruncated?: boolean;
  /** This purge's stale code-index repository sweep. */
  readonly repositorySweepState?: "pending" | "done" | "unavailable";
  /** Repositories the sweep could not remove yet. */
  readonly pendingRepositories?: number;
  /** Whether every workspace code-index overlay that may hold the purged text has republished since. */
  readonly workspaceOverlays?: "pending" | "done";
  /** Workspaces still owing that overlay, and why. Only `reason` reaches tool output; `workspace` is a path. */
  readonly pendingWorkspaceOverlays?: readonly {
    readonly workspace?: string;
    readonly reason: string;
  }[];
}

/** The memory a complete forget would erase, in any state, for the approval card. */
export interface MemoryForgetTarget {
  readonly id: string;
  readonly state: string;
  /** The requested revision's text, or the newest text its lineage still holds. */
  readonly text: string | undefined;
  readonly revisions: number;
  readonly revisionsWithText: number;
}

/** What a plain forget actually did; history fields are absent when the store cannot say. */
export interface MemoryForgetOutcome {
  readonly forgotten: true;
  readonly contentBlanked?: boolean;
  /** Earlier revisions that still hold text until a complete forget. */
  readonly historyRevisionsWithText?: number;
  readonly tombstoneKept?: boolean;
  readonly message: string;
}

/** Optional forget capabilities of an `IMemoryStore`; providers without history leave them undefined. */
export interface IMemoryForgetPort {
  /** Irreversibly purge a memory's whole lineage; null if no reachable scope holds the id. */
  forgetCompletely?(id: string, session?: MemorySessionScope): Promise<MemoryPurgeResult | null>;
  /** Resolve the memory a complete forget would erase (any state); null if not reachable. */
  forgetTarget?(id: string, session?: MemorySessionScope): Promise<MemoryForgetTarget | null>;
  /** A plain forget that reports what it left; null if the id is not active. */
  forgetWithOutcome?(id: string, session?: MemorySessionScope): Promise<MemoryForgetOutcome | null>;
}
