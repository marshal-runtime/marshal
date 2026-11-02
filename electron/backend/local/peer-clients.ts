import { runtimeTargetKey, type RuntimeTarget } from "../../../common/runtime-accounts";
import type { RuntimeQualifiedModel } from "../../../common/runtime-qualified-model";
import { forceKillRuntimeClient, isRuntimeClientDead } from "./client-process";
import { type LocalClientFactory, type LocalClientSubset, type SDKModel, log } from "./internal";

/** Resolves a client factory for a runtime and, for any account but the original, that account. */
export type PeerClientFactoryResolver = (
  runtimeId: string,
  accountId?: string,
) => LocalClientFactory | null;

interface PeerSessionBinding {
  /** `runtimeTargetKey()` of the client: `cursor`, `claude@work`. */
  targetKey: string;
  client: LocalClientSubset;
}

/**
 * Clients of other local runtimes, and of other accounts of any local runtime, started on
 * demand for sessions whose model is runtime-qualified. One client per runtime account.
 */
export class PeerRuntimeClients {
  private readonly clients = new Map<string, Promise<LocalClientSubset>>();
  /** Settled entries of `clients`, so a dead client can be detected synchronously. */
  private readonly resolvedClients = new Map<string, LocalClientSubset>();
  private readonly catalogs = new Map<string, Promise<SDKModel[]>>();
  private readonly sessions = new Map<string, PeerSessionBinding>();

  constructor(
    private readonly resolveFactory: PeerClientFactoryResolver,
    private readonly workspaceDir: string,
  ) {}

  clientForRuntime(target: RuntimeTarget): Promise<LocalClientSubset> {
    return this.client(target);
  }

  /** The account's model catalog; a failure (usually not signed in) is not remembered. */
  async catalogForRuntime(target: RuntimeTarget): Promise<SDKModel[]> {
    const client = await this.client(target);
    return this.catalog(runtimeTargetKey(target), client);
  }

  async clientForModel(target: RuntimeQualifiedModel): Promise<LocalClientSubset> {
    const key = runtimeTargetKey(target);
    const client = await this.client(target);
    const catalog = await this.catalog(key, client);
    const wanted = target.model.toLowerCase();
    if (!catalog.some((model) => model.id?.toLowerCase() === wanted)) {
      throw new Error(`Model "${target.model}" is not available in the ${key} runtime.`);
    }
    return client;
  }

  bindSession(sessionId: string, targetKey: string, client: LocalClientSubset): void {
    this.sessions.set(sessionId, { targetKey, client });
  }

  /** The `runtimeTargetKey()` a peer-hosted session runs on. */
  runtimeForSession(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.targetKey;
  }

  releaseSession(sessionId: string): LocalClientSubset | undefined {
    const binding = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    return binding?.client;
  }

  async stop(): Promise<void> {
    await Promise.all(
      this.takeClients().map(async (pending) => {
        try {
          const errors = await (await pending).stop();
          if (errors.length > 0) log.warn("Peer runtime client stopped with errors:", errors);
        } catch (error) {
          log.warn("Peer runtime client stop failed:", error);
        }
      }),
    );
  }

  kill(): void {
    this.takeClients().forEach((pending) => {
      void pending.then(
        (client) => {
          forceKillRuntimeClient(client);
          if (!client.process) {
            void client
              .stop()
              .catch((error) => log.warn("Peer runtime client stop failed:", error));
          }
        },
        () => undefined,
      );
    });
  }

  private takeClients(): Promise<LocalClientSubset>[] {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.resolvedClients.clear();
    this.catalogs.clear();
    this.sessions.clear();
    return clients;
  }

  private client(target: RuntimeTarget): Promise<LocalClientSubset> {
    const key = runtimeTargetKey(target);
    const existing = this.clients.get(key);
    const resolved = this.resolvedClients.get(key);
    if (existing && resolved && isRuntimeClientDead(resolved)) {
      // The peer's process died: its sessions are already closed and evicted,
      // so start a fresh client that resumes them from disk.
      log.warn("Replacing a peer runtime client whose process has exited:", key);
      this.clients.delete(key);
      this.resolvedClients.delete(key);
      this.catalogs.delete(key);
      forceKillRuntimeClient(resolved);
    } else if (existing) {
      return existing;
    }
    const factory = this.resolveFactory(target.runtimeId, runtimeTargetAccount(target));
    if (!factory) {
      return Promise.reject(
        new Error(`The ${key} runtime cannot run sessions next to the active runtime.`),
      );
    }
    const pending = Promise.resolve().then(() => factory(this.workspaceDir));
    this.clients.set(key, pending);
    pending.then(
      (client) => {
        if (this.clients.get(key) === pending) this.resolvedClients.set(key, client);
      },
      () => {
        if (this.clients.get(key) === pending) this.clients.delete(key);
      },
    );
    return pending;
  }

  private catalog(key: string, client: LocalClientSubset): Promise<SDKModel[]> {
    const existing = this.catalogs.get(key);
    if (existing) return existing;
    const pending = client.listModels();
    this.catalogs.set(key, pending);
    pending.catch(() => {
      if (this.catalogs.get(key) === pending) this.catalogs.delete(key);
      this.evictIdleClient(key, client);
    });
    return pending;
  }

  /**
   * A catalog failure usually means the account is not signed in yet. An idle client is
   * dropped so the next session after sign-in starts a fresh one that sees the new
   * credentials; a client still running sessions is kept.
   */
  private evictIdleClient(key: string, client: LocalClientSubset): void {
    if ([...this.sessions.values()].some((binding) => binding.client === client)) return;
    const pending = this.clients.get(key);
    if (!pending) return;
    void pending.then((current) => {
      if (current !== client || this.clients.get(key) !== pending) return;
      this.clients.delete(key);
      this.resolvedClients.delete(key);
      void client.stop().catch((error) => log.warn("Peer runtime client stop failed:", error));
    });
  }
}

function runtimeTargetAccount(target: RuntimeTarget): string | undefined {
  return runtimeTargetKey(target) === target.runtimeId ? undefined : target.accountId;
}
