import type {
  MSettings,
  RuntimeAccountView,
  RuntimeAccountsView,
} from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import { unavailableUsage, type RuntimeAccountUsage } from "../common/runtime-account-usage";
import {
  ACCOUNT_RUNTIME_IDS,
  DEFAULT_RUNTIME_ACCOUNT_ID,
  RUNTIME_ACCOUNT_AUTH_METHODS,
  RUNTIME_ACCOUNT_SEPARATOR,
  defaultRuntimeAccountId,
  isAccountRuntimeId,
  isOriginalRuntimeAccount,
  listRuntimeAccounts,
  normalizeRuntimeAccounts,
  runtimeAccountIdFromLabel,
  runtimeAccountLabel,
  runtimeTargetKey,
  type AccountRuntimeId,
  type RuntimeAccount,
  type RuntimeAccountsSettings,
} from "../common/runtime-accounts";
import type {
  RuntimeAuthLoginRequest,
  RuntimeAuthLoginState,
  RuntimeAuthStatus,
} from "../common/runtime-auth";
import { getRuntimeMetadata } from "../common/runtime-config";
import { mapRuntimeAuthLoginResult } from "./backend/local/runtime-auth";
import type { RuntimeClient, RuntimeClientFactory } from "./backend/runtime-contract";

const log = createLogger("RuntimeAccounts");

const MAX_ACCOUNTS_PER_RUNTIME = 8;

/** Settings polls usage while open and the keep-alive job reads it too; one read per account per window. */
const USAGE_CACHE_TTL_MS = 60_000;

export interface RuntimeAccountsManagerDeps {
  settings: { get(): MSettings; update(partial: Partial<MSettings>): void };
  /** Client factory for one account of a runtime; `undefined` is the original account. */
  createClientFactory(runtimeId: AccountRuntimeId, accountId?: string): RuntimeClientFactory | null;
  workspaceDir: string;
  /** Accounts were added, removed, signed in or out: their model lists may have changed. */
  onSignInChanged?(): void;
}

/**
 * Adds, signs in, and removes the accounts of local runtimes. Sign-in runs on a short-lived
 * client of that account, so it never disturbs the clients hosting live sessions.
 */
export class RuntimeAccountsManager {
  private readonly pendingLogins = new Map<string, RuntimeClient>();
  private readonly usageCache = new Map<string, { usage: RuntimeAccountUsage; at: number }>();
  private readonly usageReads = new Map<string, Promise<RuntimeAccountUsage>>();
  /** Bumped when accounts or sign-ins change so reads started before the change are not cached. */
  private usageGeneration = 0;

  constructor(private readonly deps: RuntimeAccountsManagerDeps) {}

  list(): RuntimeAccountsView[] {
    const settings = this.accountsSettings();
    return ACCOUNT_RUNTIME_IDS.map((runtimeId) => {
      const metadata = getRuntimeMetadata(runtimeId);
      const allowed = new Set(RUNTIME_ACCOUNT_AUTH_METHODS[runtimeId]);
      return {
        runtimeId,
        displayName: metadata.displayName,
        authMethods: metadata.auth.methods
          .filter((method) => allowed.has(method.type))
          .map(({ type, label }) => ({ type, label })),
        accounts: listRuntimeAccounts(settings, runtimeId).map((account) =>
          this.view(runtimeId, account, settings),
        ),
      };
    });
  }

  add(runtimeId: string, label: string): RuntimeAccountView {
    const runtime = requireAccountRuntime(runtimeId);
    const trimmed = requireLabel(label);
    const settings = this.accountsSettings();
    const existing = listRuntimeAccounts(settings, runtime);
    if (existing.length >= MAX_ACCOUNTS_PER_RUNTIME) {
      throw new Error(`A runtime can have at most ${MAX_ACCOUNTS_PER_RUNTIME} accounts`);
    }
    const account = {
      id: runtimeAccountIdFromLabel(trimmed, new Set(existing.map((entry) => entry.id))),
      label: trimmed,
    };
    const config = settings?.[runtime] ?? {};
    const next = this.save({
      ...settings,
      [runtime]: { ...config, accounts: [...(config.accounts ?? []), account] },
    });
    return this.view(runtime, account, next);
  }

  rename(runtimeId: string, accountId: string, label: string): void {
    const runtime = requireAccountRuntime(runtimeId);
    const trimmed = requireLabel(label);
    const settings = this.accountsSettings();
    this.requireAccount(runtime, accountId, settings);
    const config = settings?.[runtime] ?? {};
    const accounts = config.accounts ?? [];
    const renamed = accounts.some((account) => account.id === accountId)
      ? accounts.map((account) =>
          account.id === accountId ? { ...account, label: trimmed } : account,
        )
      : [{ id: accountId, label: trimmed }, ...accounts];
    this.save({ ...settings, [runtime]: { ...config, accounts: renamed } });
  }

  /** Forgets an account after signing it out; sessions pinned to it fail until it is re-added. */
  async remove(runtimeId: string, accountId: string): Promise<void> {
    const runtime = requireAccountRuntime(runtimeId);
    if (isOriginalRuntimeAccount(accountId)) {
      throw new Error("The original account cannot be removed; sign it out instead");
    }
    this.requireAccount(runtime, accountId, this.accountsSettings());
    await this.signOut(runtime, accountId).catch((error: unknown) => {
      log.warn("Removed account could not be signed out:", error);
    });
    const settings = this.accountsSettings();
    const config = { ...settings?.[runtime] };
    config.accounts = (config.accounts ?? []).filter((account) => account.id !== accountId);
    if (config.defaultAccountId === accountId) delete config.defaultAccountId;
    this.save({ ...settings, [runtime]: config });
  }

  setDefault(runtimeId: string, accountId: string): void {
    const runtime = requireAccountRuntime(runtimeId);
    const settings = this.accountsSettings();
    this.requireAccount(runtime, accountId, settings);
    const config = { ...settings?.[runtime] };
    if (isOriginalRuntimeAccount(accountId)) delete config.defaultAccountId;
    else config.defaultAccountId = accountId;
    this.save({ ...settings, [runtime]: config });
  }

  async getStatus(runtimeId: string, accountId: string): Promise<RuntimeAuthStatus> {
    const runtime = requireAccountRuntime(runtimeId);
    this.requireAccount(runtime, accountId, this.accountsSettings());
    return this.withClient(runtime, accountId, async (client) => {
      const status = await client.getAuthStatus();
      return {
        isAuthenticated: status.isAuthenticated,
        ...(status.login ? { login: status.login } : {}),
        ...(status.statusMessage ? { statusMessage: status.statusMessage } : {}),
      };
    });
  }

  async login(
    runtimeId: string,
    accountId: string,
    request: RuntimeAuthLoginRequest,
  ): Promise<RuntimeAuthLoginState> {
    const runtime = requireAccountRuntime(runtimeId);
    this.requireAccount(runtime, accountId, this.accountsSettings());
    if (!(RUNTIME_ACCOUNT_AUTH_METHODS[runtime] as readonly string[]).includes(request.type)) {
      throw new Error(
        `${getRuntimeMetadata(runtime).displayName} accounts cannot use that sign-in`,
      );
    }
    const key = runtimeTargetKey({ runtimeId: runtime, accountId });
    await this.cancelPendingLogin(key);
    const client = await this.startClient(runtime, accountId);
    let pending = false;
    try {
      if (!client.login) throw new Error(`${runtime} does not support signing in`);
      const result = mapRuntimeAuthLoginResult(client, await client.login(request));
      const { method } = result;
      if (!method || !result.completion) {
        this.signInChanged();
        return { status: "authenticated" };
      }
      pending = true;
      this.pendingLogins.set(key, client);
      void result.completion
        .catch((error: unknown) => log.warn("Account sign-in did not complete:", error))
        .finally(() => {
          this.signInChanged();
          if (this.pendingLogins.get(key) !== client) return;
          this.pendingLogins.delete(key);
          void stopClient(client);
        });
      return {
        status: "pending",
        method,
        ...(result.verificationUri ? { verificationUri: result.verificationUri } : {}),
        ...(result.deviceCode ? { userCode: result.deviceCode } : {}),
      };
    } finally {
      if (!pending) await stopClient(client);
    }
  }

  async signOut(runtimeId: string, accountId: string): Promise<void> {
    const runtime = requireAccountRuntime(runtimeId);
    this.requireAccount(runtime, accountId, this.accountsSettings());
    await this.cancelPendingLogin(runtimeTargetKey({ runtimeId: runtime, accountId }));
    await this.withClient(runtime, accountId, async (client) => {
      if (!client.logout) throw new Error(`${runtime} does not support signing out`);
      await client.logout();
    });
    this.signInChanged();
  }

  /**
   * Plan usage of one account, read on a short-lived client so it needs no live session.
   * Reads of one account never overlap, and a result is reused for a minute unless `force`.
   */
  async getUsage(
    runtimeId: string,
    accountId: string,
    options: { force?: boolean } = {},
  ): Promise<RuntimeAccountUsage> {
    const runtime = requireAccountRuntime(runtimeId);
    this.requireAccount(runtime, accountId, this.accountsSettings());
    const key = runtimeTargetKey({ runtimeId: runtime, accountId });
    const cached = this.usageCache.get(key);
    if (!options.force && cached && Date.now() - cached.at < USAGE_CACHE_TTL_MS) {
      return cached.usage;
    }
    const running = this.usageReads.get(key);
    if (running) return running;
    const generation = this.usageGeneration;
    const read = this.readUsage(runtime, accountId)
      .then((usage) => {
        if (generation === this.usageGeneration) {
          this.usageCache.set(key, { usage, at: Date.now() });
        }
        return usage;
      })
      .finally(() => this.usageReads.delete(key));
    this.usageReads.set(key, read);
    return read;
  }

  /** The newest usage read of an account, however old; undefined before any read or after a sign-in change. */
  lastKnownUsage(runtimeId: string, accountId: string): RuntimeAccountUsage | undefined {
    return this.usageCache.get(runtimeTargetKey({ runtimeId, accountId }))?.usage;
  }

  async stop(): Promise<void> {
    const clients = [...this.pendingLogins.values()];
    this.pendingLogins.clear();
    await Promise.all(clients.map(stopClient));
  }

  private accountsSettings(): RuntimeAccountsSettings | undefined {
    return normalizeRuntimeAccounts(this.deps.settings.get().runtimeAccounts);
  }

  private save(next: RuntimeAccountsSettings): RuntimeAccountsSettings | undefined {
    const normalized = normalizeRuntimeAccounts(next);
    this.deps.settings.update({ runtimeAccounts: normalized });
    this.signInChanged();
    return normalized;
  }

  private view(
    runtimeId: AccountRuntimeId,
    account: RuntimeAccount,
    settings: RuntimeAccountsSettings | undefined,
  ): RuntimeAccountView {
    const defaultId = defaultRuntimeAccountId(settings, runtimeId) ?? DEFAULT_RUNTIME_ACCOUNT_ID;
    const isOriginal = isOriginalRuntimeAccount(account.id);
    const isDefault = account.id === defaultId;
    return {
      id: account.id,
      label: runtimeAccountLabel(account),
      isOriginal,
      isDefault,
      // A bare `claude:` prefix follows the default account, so the original needs `@default`.
      targetKey:
        isOriginal && !isDefault
          ? `${runtimeId}${RUNTIME_ACCOUNT_SEPARATOR}${DEFAULT_RUNTIME_ACCOUNT_ID}`
          : runtimeTargetKey({ runtimeId, accountId: account.id }),
    };
  }

  private requireAccount(
    runtimeId: AccountRuntimeId,
    accountId: string,
    settings: RuntimeAccountsSettings | undefined,
  ): void {
    if (!listRuntimeAccounts(settings, runtimeId).some((account) => account.id === accountId)) {
      throw new Error(`Unknown ${runtimeId} account "${accountId}"`);
    }
  }

  private async startClient(runtimeId: AccountRuntimeId, accountId: string) {
    const factory = this.deps.createClientFactory(
      runtimeId,
      isOriginalRuntimeAccount(accountId) ? undefined : accountId,
    );
    if (!factory) throw new Error(`${runtimeId} accounts are unavailable`);
    return factory(this.deps.workspaceDir);
  }

  private async withClient<T>(
    runtimeId: AccountRuntimeId,
    accountId: string,
    run: (client: RuntimeClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.startClient(runtimeId, accountId);
    try {
      return await run(client);
    } finally {
      await stopClient(client);
    }
  }

  private async readUsage(
    runtimeId: AccountRuntimeId,
    accountId: string,
  ): Promise<RuntimeAccountUsage> {
    try {
      const usage = await this.withClient(runtimeId, accountId, (client) =>
        client.getUsage ? client.getUsage() : Promise.resolve(null),
      );
      return usage ?? unavailableUsage("not_applicable", "This runtime does not report plan usage");
    } catch (error) {
      log.warn("Account usage read failed:", error instanceof Error ? error.name : "unknown");
      return unavailableUsage("error", "Plan usage could not be loaded");
    }
  }

  private signInChanged(): void {
    this.usageGeneration += 1;
    this.usageCache.clear();
    this.deps.onSignInChanged?.();
  }

  private async cancelPendingLogin(key: string): Promise<void> {
    const client = this.pendingLogins.get(key);
    if (!client) return;
    this.pendingLogins.delete(key);
    await stopClient(client);
  }
}

function requireAccountRuntime(runtimeId: string): AccountRuntimeId {
  if (!isAccountRuntimeId(runtimeId)) throw new Error(`${runtimeId} does not support accounts`);
  return runtimeId;
}

function requireLabel(label: string): string {
  const trimmed = typeof label === "string" ? label.trim() : "";
  if (!trimmed) throw new Error("Account name is required");
  if (trimmed.length > 64) throw new Error("Account name must be 64 characters or fewer");
  return trimmed;
}

async function stopClient(client: RuntimeClient): Promise<void> {
  try {
    const errors = await client.stop();
    if (errors.length > 0) log.warn("Account client stopped with errors:", errors);
  } catch (error) {
    log.warn("Account client stop failed:", error);
  }
}
