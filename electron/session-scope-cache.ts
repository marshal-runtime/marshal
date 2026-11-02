import type { PersistedSession } from "./session-store";

/** Every persisted session field except the transcript. */
export type SessionMetadataSnapshot = Readonly<Omit<PersistedSession, "messages">>;

/** The session fields that runtime authority, delegation and scope checks need. */
export type SessionScope = Pick<
  PersistedSession,
  | "id"
  | "name"
  | "workspaceName"
  | "repoPath"
  | "source"
  | "runtimeId"
  | "backendOrigin"
  | "automationId"
  | "runtimeDelegationId"
  | "runtimeTaskController"
>;

export function sessionScopeOf(session: SessionScope): SessionScope {
  return {
    id: session.id,
    name: session.name,
    ...(session.workspaceName === undefined ? {} : { workspaceName: session.workspaceName }),
    ...(session.repoPath === undefined ? {} : { repoPath: session.repoPath }),
    ...(session.source === undefined ? {} : { source: session.source }),
    ...(session.runtimeId === undefined ? {} : { runtimeId: session.runtimeId }),
    ...(session.backendOrigin === undefined ? {} : { backendOrigin: session.backendOrigin }),
    ...(session.automationId === undefined ? {} : { automationId: session.automationId }),
    ...(session.runtimeDelegationId === undefined
      ? {}
      : { runtimeDelegationId: session.runtimeDelegationId }),
    ...(session.runtimeTaskController === undefined
      ? {}
      : { runtimeTaskController: session.runtimeTaskController }),
  };
}

/** A full session or its stored header; either carries fields metadata must not keep. */
type SessionMetadataSource = Omit<PersistedSession, "messages"> & {
  readonly messages?: unknown;
  readonly storageFormat?: unknown;
  readonly chunkGen?: unknown;
  readonly chunkCount?: unknown;
  readonly messageCount?: unknown;
  readonly lastMessagePreview?: unknown;
};

function metadataOf(session: SessionMetadataSource): SessionMetadataSnapshot {
  const {
    messages: _messages,
    storageFormat: _storageFormat,
    chunkGen: _chunkGen,
    chunkCount: _chunkCount,
    messageCount: _messageCount,
    lastMessagePreview: _lastMessagePreview,
    ...metadata
  } = session;
  return Object.freeze(metadata);
}

/**
 * Metadata (everything but messages) of recently read or written sessions, so
 * per-call policy and scope checks neither rebuild the transcript nor decrypt
 * the header. The store refreshes an entry every time it writes that session's
 * header and drops it when the session is deleted.
 */
export class SessionMetadataCache {
  readonly #entries = new Map<string, SessionMetadataSnapshot>();

  get(id: string): SessionMetadataSnapshot | undefined {
    return this.#entries.get(id);
  }

  remember(session: SessionMetadataSource): SessionMetadataSnapshot {
    const metadata = metadataOf(session);
    this.#entries.set(metadata.id, metadata);
    return metadata;
  }

  forget(id: string): void {
    this.#entries.delete(id);
  }
}
