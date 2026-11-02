import type { MemoryEntry, MemoryCategory } from "../common/marshal-ipc-contract";
import type {
  IMemoryStore,
  MemoryAddOptions,
  MemoryForgetOutcome,
  MemoryForgetTarget,
  MemoryPromptSelection,
  MemoryPromptSelectionRequest,
  MemoryPurgeResult,
  MemoryRecallOptions,
  MemorySessionScope,
} from "./backend/ports";
import {
  FORGET_COMPLETELY_UNSUPPORTED,
  FORGOTTEN_HISTORY_UNKNOWN,
  REMOVED_WITHOUT_HISTORY,
  factForId,
  forgetTargetFromList,
  removeLocalFactCopies,
} from "./marshal-runtime/memory/local-memory-purge";
import {
  formatMemoryPromptFromStore,
  selectMemoriesForPromptFromStore,
} from "./marshal-runtime/memory/prompt-selection";
import { ProviderRegistry } from "./provider-registry";

export const LOCAL_MEMORY_PROVIDER_ID = "local";
const DEFAULT_EXTENSION_MEMORY_PROVIDER_ID = "@marshal/brain";

export interface MemoryStoreProvider {
  readonly id: string;
  readonly store: IMemoryStore;
  dispose?(): void | Promise<void>;
}

export interface MemoryProviderRegistrationService {
  register(provider: MemoryStoreProvider): Promise<{ dispose(): Promise<void> }>;
}

type ProviderContext = Record<never, never>;

/**
 * Stable memory-store facade used by sessions, prompts, and Runtime tools.
 * Provider swaps are atomic. Async operations retain a lease on the delegate
 * they started with, and disposal waits for those leases to settle.
 */
export class ActiveMemoryStore implements IMemoryStore, MemoryProviderRegistrationService {
  private readonly providers = new ProviderRegistry<ProviderContext, MemoryStoreProvider>();
  private readonly local: MemoryStoreProvider;
  private active: MemoryStoreProvider;
  private readonly inFlight = new Map<MemoryStoreProvider, Set<Promise<unknown>>>();
  private transition = Promise.resolve();

  constructor(
    localStore: IMemoryStore,
    private readonly preferredProviderId = DEFAULT_EXTENSION_MEMORY_PROVIDER_ID,
  ) {
    this.local = { id: LOCAL_MEMORY_PROVIDER_ID, store: localStore };
    this.active = this.local;
    this.providers.register({ id: this.local.id, create: () => this.local });
  }

  get activeProviderId(): string {
    return this.active.id;
  }

  async register(provider: MemoryStoreProvider): Promise<{ dispose(): Promise<void> }> {
    if (!provider.id.trim() || provider.id === LOCAL_MEMORY_PROVIDER_ID) {
      throw new Error("Extension memory providers require a non-local provider ID.");
    }
    assertMemoryStore(provider.store);
    const unregister = this.providers.register({ id: provider.id, create: () => provider });
    try {
      await this.enqueueTransition(async () => {
        const localFacts = this.local.store.list();
        if (localFacts.length > 0) {
          await provider.store.initializeSessionStart(localFacts);
        }
        if (provider.id === this.preferredProviderId) {
          this.active = this.providers.create(provider.id, {});
        }
      });
    } catch (error) {
      unregister();
      throw error;
    }
    let disposed = false;
    return {
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        unregister();
        await this.enqueueTransition(async () => {
          if (this.active === provider) this.active = this.local;
          await this.drain(provider);
          await provider.dispose?.();
        });
      },
    };
  }

  list(): MemoryEntry[] {
    return this.active.store.list();
  }
  count(): number {
    return this.active.store.count();
  }
  add(
    fact: string,
    category?: MemoryCategory,
    source?: string,
    options?: MemoryAddOptions,
  ): Promise<MemoryEntry | null> {
    return this.lease((store) =>
      Promise.resolve(
        options ? store.add(fact, category, source, options) : store.add(fact, category, source),
      ),
    );
  }
  /** With an extension provider active, also removes the local fallback copies of the fact. */
  delete(id: string): Promise<boolean> {
    return this.lease(async (store) => {
      const fact = store === this.local.store ? undefined : factForId(store, id);
      const deleted = await store.delete(id);
      if (deleted && fact !== undefined) await removeLocalFactCopies(this.local.store, [fact]);
      return deleted;
    });
  }
  /** A plain forget reporting what it left; stores without history remove the entry outright. */
  forgetWithOutcome(id: string, session?: MemorySessionScope): Promise<MemoryForgetOutcome | null> {
    return this.lease(async (store) => {
      const fact = store === this.local.store ? undefined : factForId(store, id);
      const outcome =
        typeof store.forgetWithOutcome === "function"
          ? await store.forgetWithOutcome(id, session)
          : (await store.delete(id))
            ? store === this.local.store
              ? REMOVED_WITHOUT_HISTORY
              : FORGOTTEN_HISTORY_UNKNOWN
            : null;
      if (outcome && fact !== undefined) await removeLocalFactCopies(this.local.store, [fact]);
      return outcome;
    });
  }
  /** The memory a complete forget would erase; `session` reaches its workspace and project memories. */
  forgetTarget(id: string, session?: MemorySessionScope): Promise<MemoryForgetTarget | null> {
    return this.lease(async (store) =>
      typeof store.forgetTarget === "function"
        ? store.forgetTarget(id, session)
        : forgetTargetFromList(store, id),
    );
  }
  /**
   * Irreversible purge through the active provider, plus removal of the local
   * fallback copies. Throws `code: "not_supported"` when the provider has none.
   */
  forgetCompletely(id: string, session?: MemorySessionScope): Promise<MemoryPurgeResult | null> {
    return this.lease(async (store) => {
      if (typeof store.forgetCompletely !== "function") {
        throw Object.assign(new Error(FORGET_COMPLETELY_UNSUPPORTED), { code: "not_supported" });
      }
      const fact = store === this.local.store ? undefined : factForId(store, id);
      const result = session ? await store.forgetCompletely(id, session) : await store.forgetCompletely(id);
      if (result && store !== this.local.store) {
        const purgedFacts = Array.isArray(result.purgedFacts) ? result.purgedFacts : [];
        await removeLocalFactCopies(this.local.store, [fact, ...purgedFacts]);
      }
      return result;
    });
  }
  clear(): Promise<void> {
    return this.lease((store) => Promise.resolve(store.clear()));
  }
  addBatch(
    entries: Array<{ fact: string; source?: string }>,
    source?: string,
  ): Promise<MemoryEntry[]> {
    return this.lease((store) => Promise.resolve(store.addBatch(entries, source)));
  }
  recall(
    query: string,
    limit?: number,
    source?: string,
    options?: MemoryRecallOptions,
  ): Promise<MemoryEntry[]> {
    return this.lease((store) =>
      options ? store.recall(query, limit, source, options) : store.recall(query, limit, source),
    );
  }
  getRecent(n: number): MemoryEntry[] {
    return this.active.store.getRecent(n);
  }
  retrieveSemanticSubset(query: string, limit?: number): Promise<MemoryEntry[]> {
    return this.lease((store) => store.retrieveSemanticSubset(query, limit));
  }
  export(): string {
    return this.active.store.export();
  }
  import(
    json: string,
  ): Promise<{ added: number; skipped: number; error?: string }> {
    return this.lease((store) => Promise.resolve(store.import(json)));
  }
  reload(): void {
    this.active.store.reload();
  }
  initializeSessionStart(localMemories?: MemoryEntry[]): Promise<void> {
    return this.lease((store) => store.initializeSessionStart(localMemories));
  }
  selectForPrompt(request: MemoryPromptSelectionRequest): MemoryPromptSelection {
    return selectMemoriesForPromptFromStore(this.active.store, request);
  }
  formatForSystemPrompt(request?: Partial<MemoryPromptSelectionRequest>): string {
    return formatMemoryPromptFromStore(this.active.store, request);
  }

  private lease<T>(operation: (store: IMemoryStore) => Promise<T>): Promise<T> {
    const provider = this.active;
    const pending = Promise.resolve().then(() => operation(provider.store));
    const leases = this.inFlight.get(provider) ?? new Set<Promise<unknown>>();
    this.inFlight.set(provider, leases);
    leases.add(pending);
    const release = () => {
      leases.delete(pending);
      if (leases.size === 0) this.inFlight.delete(provider);
    };
    void pending.then(release, release);
    return pending;
  }

  private async drain(provider: MemoryStoreProvider): Promise<void> {
    const leases = this.inFlight.get(provider);
    if (leases?.size) await Promise.allSettled([...leases]);
  }

  private enqueueTransition(operation: () => Promise<void>): Promise<void> {
    const next = this.transition.then(operation, operation);
    this.transition = next.catch(() => undefined);
    return next;
  }
}

function assertMemoryStore(value: IMemoryStore): void {
  const methods: ReadonlyArray<keyof IMemoryStore> = [
    "list", "count", "add", "delete", "clear", "addBatch", "recall", "getRecent",
    "retrieveSemanticSubset", "export", "import", "reload", "initializeSessionStart",
    "formatForSystemPrompt",
  ];
  for (const method of methods) {
    if (typeof value[method] !== "function") {
      throw new Error(`Memory provider is missing required method ${method}.`);
    }
  }
}
