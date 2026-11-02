interface ParsedChunkEntry<T> {
  readonly sessionId: string;
  readonly gen: string;
  readonly value: T;
  readonly size: number;
}

function chunkKey(sessionId: string, gen: string, index: number): string {
  return `${sessionId}\u0000${gen}\u0000${index}`;
}

/**
 * Validated message chunks of the local session store, kept so repeated full
 * session loads skip the decrypt, JSON.parse and schema pass per chunk. Those
 * loads ran several times per subagent idle event on multi-hundred-MB session
 * stores and held the main thread for seconds.
 *
 * A chunk file is written once into a fresh generation directory and never
 * rewritten, so (session, generation, index) identifies its content exactly.
 * Readers still re-read the header, which names the current generation, so a
 * stale generation can only miss. Least-recently-used entries are dropped once
 * the decrypted JSON length of all entries exceeds `maxSize`.
 */
export class ParsedChunkCache<T> {
  private readonly entries = new Map<string, ParsedChunkEntry<T>>();
  private readonly keysBySession = new Map<string, Set<string>>();
  private totalSize = 0;

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.totalSize;
  }

  get(sessionId: string, gen: string, index: number): T | undefined {
    const key = chunkKey(sessionId, gen, index);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(sessionId: string, gen: string, index: number, value: T, size: number): void {
    const key = chunkKey(sessionId, gen, index);
    this.deleteKey(key);
    if (size > this.maxSize) return;
    this.entries.set(key, { sessionId, gen, value, size });
    let keys = this.keysBySession.get(sessionId);
    if (!keys) {
      keys = new Set();
      this.keysBySession.set(sessionId, keys);
    }
    keys.add(key);
    this.totalSize += size;
    while (this.totalSize > this.maxSize) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.deleteKey(oldest.value);
    }
  }

  /** Re-key a chunk whose file was carried byte-identical into a new generation. */
  carry(sessionId: string, fromGen: string, toGen: string, index: number): void {
    const entry = this.entries.get(chunkKey(sessionId, fromGen, index));
    if (!entry) return;
    this.deleteKey(chunkKey(sessionId, fromGen, index));
    this.set(sessionId, toGen, index, entry.value, entry.size);
  }

  /** Mirrors generation garbage collection: drop generations sorting before `keepGen`. */
  dropGenerationsBefore(sessionId: string, keepGen: string): void {
    const keys = this.keysBySession.get(sessionId);
    if (!keys) return;
    for (const key of [...keys]) {
      const entry = this.entries.get(key);
      if (entry && entry.gen < keepGen) this.deleteKey(key);
    }
  }

  dropSession(sessionId: string): void {
    const keys = this.keysBySession.get(sessionId);
    if (!keys) return;
    for (const key of [...keys]) this.deleteKey(key);
  }

  private deleteKey(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalSize -= entry.size;
    const keys = this.keysBySession.get(entry.sessionId);
    keys?.delete(key);
    if (keys?.size === 0) this.keysBySession.delete(entry.sessionId);
  }
}
