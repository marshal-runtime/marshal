/**
 * RuntimeModelCatalog — the models other runtimes and accounts offer next to the
 * active runtime's own, so one chat can switch between, say, a Claude and a Codex
 * subscription from the model picker.
 *
 * Every peer account is fetched on its own with a timeout and cached; a cold or
 * expired entry never delays the caller (the cached models are returned and the
 * fetch finishes in the background, then `onChanged` fires so the renderer
 * re-queries). A target that fails — usually because it is not signed in — is
 * left out until its short failure cache expires.
 */

import type { ModelInfo, ModelRuntimeInfo } from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import {
  ACCOUNT_RUNTIME_IDS,
  DEFAULT_RUNTIME_ACCOUNT_ID,
  RUNTIME_ACCOUNT_SEPARATOR,
  defaultRuntimeAccountId,
  isOriginalRuntimeAccount,
  listRuntimeAccounts,
  runtimeAccountLabel,
  runtimeTargetKey,
  type RuntimeAccountsSettings,
  type RuntimeTarget,
} from "../common/runtime-accounts";
import { getRuntimeDisplayName } from "../common/runtime-config";
import { PEER_RUNTIME_IDS, RUNTIME_MODEL_SEPARATOR } from "../common/runtime-qualified-model";

const log = createLogger("RuntimeModelCatalog");

const FETCH_TIMEOUT_MS = 5_000;
const SUCCESS_TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 60_000;

export interface RuntimeModelCatalogDeps {
  getActiveRuntimeId(): string;
  getAccounts(): RuntimeAccountsSettings | undefined;
  listModelsForRuntime(target: RuntimeTarget): Promise<ModelInfo[]>;
  isModelDisabled(modelId: string): boolean;
  /** Fired when a background fetch changed what `listPeerModels` returns. */
  onChanged(): void;
  now?(): number;
  fetchTimeoutMs?: number;
  successTtlMs?: number;
  failureTtlMs?: number;
}

interface CatalogSlot {
  /** Where the account's models are fetched from. */
  fetchTarget: RuntimeTarget;
  /** Prefix that makes a plain model id of this account unambiguous: `claude`, `claude@work`. */
  prefix: string;
  group: ModelRuntimeInfo;
  isRuntimeDefault: boolean;
}

interface CacheEntry {
  models: ModelInfo[];
  expiresAt: number;
  ok: boolean;
}

/** Heading for one account of a runtime: `Codex`, or `Claude Agent · work` once accounts are named. */
export function runtimeGroupLabel(
  settings: RuntimeAccountsSettings | undefined,
  runtimeId: string,
  accountId?: string,
): string {
  const name = getRuntimeDisplayName(runtimeId);
  const accounts = listRuntimeAccounts(settings, runtimeId);
  const account = accounts.find((entry) => entry.id === (accountId ?? DEFAULT_RUNTIME_ACCOUNT_ID));
  if (accounts.length === 1 && !account?.label) return name;
  return `${name} · ${account ? runtimeAccountLabel(account) : (accountId ?? "Primary")}`;
}

/** The group of the active runtime's own (unqualified) models. */
export function activeRuntimeGroup(
  settings: RuntimeAccountsSettings | undefined,
  runtimeId: string,
): ModelRuntimeInfo {
  const accountId = defaultRuntimeAccountId(settings, runtimeId);
  return {
    runtimeId,
    ...(accountId ? { accountId } : {}),
    label: runtimeGroupLabel(settings, runtimeId, accountId),
  };
}

export class RuntimeModelCatalog {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private generation = 0;

  constructor(private readonly deps: RuntimeModelCatalogDeps) {}

  /** Cached models of every other runtime account, qualified and grouped; starts missing fetches. */
  listPeerModels(): ModelInfo[] {
    const slots = this.slots();
    const now = this.now();
    const defaults: ModelInfo[] = [];
    const extras: ModelInfo[] = [];
    for (const slot of slots) {
      const key = runtimeTargetKey(slot.fetchTarget);
      const entry = this.cache.get(key);
      if (!entry || entry.expiresAt <= now) this.refresh(key, slot.fetchTarget);
      if (!entry?.ok) continue;
      const bucket = slot.isRuntimeDefault ? defaults : extras;
      for (const model of entry.models) {
        const id = `${slot.prefix}${RUNTIME_MODEL_SEPARATOR}${model.id}`;
        if (this.deps.isModelDisabled(id)) continue;
        bucket.push({ ...model, id, runtime: slot.group });
      }
    }
    return [...defaults, ...extras];
  }

  /** Forgets every fetched catalog, e.g. after a sign-in change or a runtime switch. */
  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
    this.inFlight.clear();
  }

  private slots(): CatalogSlot[] {
    const activeRuntimeId = this.deps.getActiveRuntimeId();
    if (!PEER_RUNTIME_IDS.has(activeRuntimeId)) return [];
    const settings = this.deps.getAccounts();
    const slots: CatalogSlot[] = [];
    for (const runtimeId of ACCOUNT_RUNTIME_IDS) {
      const defaultId = defaultRuntimeAccountId(settings, runtimeId) ?? DEFAULT_RUNTIME_ACCOUNT_ID;
      for (const account of listRuntimeAccounts(settings, runtimeId)) {
        const isRuntimeDefault = account.id === defaultId;
        if (isRuntimeDefault && runtimeId === activeRuntimeId) continue;
        const original = isOriginalRuntimeAccount(account.id);
        slots.push({
          fetchTarget: original ? { runtimeId } : { runtimeId, accountId: account.id },
          // A bare `claude:` prefix follows the default account, so a non-default original needs `@default`.
          prefix:
            original && !isRuntimeDefault
              ? `${runtimeId}${RUNTIME_ACCOUNT_SEPARATOR}${DEFAULT_RUNTIME_ACCOUNT_ID}`
              : runtimeTargetKey({ runtimeId, accountId: account.id }),
          group: {
            runtimeId,
            ...(original ? {} : { accountId: account.id }),
            label: runtimeGroupLabel(settings, runtimeId, account.id),
          },
          isRuntimeDefault,
        });
      }
    }
    return slots;
  }

  private refresh(key: string, target: RuntimeTarget): void {
    if (this.inFlight.has(key)) return;
    const generation = this.generation;
    const hadModels = (this.cache.get(key)?.models.length ?? 0) > 0;
    const run = this.fetch(target).then(
      (models) => ({ models, ok: true }),
      (error: unknown) => {
        log.info(`Model catalog for ${key} is unavailable:`, error);
        return { models: [] as ModelInfo[], ok: false };
      },
    );
    const settled = run.then(({ models, ok }) => {
      if (generation !== this.generation) return;
      const ttl = ok
        ? (this.deps.successTtlMs ?? SUCCESS_TTL_MS)
        : (this.deps.failureTtlMs ?? FAILURE_TTL_MS);
      this.cache.set(key, { models, ok, expiresAt: this.now() + ttl });
      this.inFlight.delete(key);
      if (models.length > 0 || hadModels) this.deps.onChanged();
    });
    this.inFlight.set(key, settled);
  }

  private fetch(target: RuntimeTarget): Promise<ModelInfo[]> {
    const timeoutMs = this.deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    return new Promise<ModelInfo[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Listing models timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.deps.listModelsForRuntime(target).then(
        (models) => {
          clearTimeout(timer);
          resolve(models);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
