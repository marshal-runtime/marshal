import type { RuntimeInteractiveAuthMethod } from "./runtime-auth";
import { CLAUDE_RUNTIME_ID, CODEX_RUNTIME_ID, CURSOR_RUNTIME_ID } from "./runtime-config";

/** The account a runtime used before accounts existed; its credentials keep their original home. */
export const DEFAULT_RUNTIME_ACCOUNT_ID = "default";
export const RUNTIME_ACCOUNT_SEPARATOR = "@";

/** Runtimes that can hold more than one signed-in account. */
export const ACCOUNT_RUNTIME_IDS = [
  CLAUDE_RUNTIME_ID,
  CODEX_RUNTIME_ID,
  CURSOR_RUNTIME_ID,
] as const;
export type AccountRuntimeId = (typeof ACCOUNT_RUNTIME_IDS)[number];

/**
 * Sign-in methods whose credentials persist in an account's own home. Claude API keys
 * live only in the signing-in client's memory, so a Claude account signs in with its browser.
 */
export const RUNTIME_ACCOUNT_AUTH_METHODS: Readonly<
  Record<AccountRuntimeId, readonly RuntimeInteractiveAuthMethod[]>
> = {
  [CLAUDE_RUNTIME_ID]: ["browser"],
  [CODEX_RUNTIME_ID]: ["browser", "device-code", "api-key"],
  [CURSOR_RUNTIME_ID]: ["browser", "api-key"],
};

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_ACCOUNT_LABEL_LENGTH = 64;

export interface RuntimeAccount {
  id: string;
  label?: string;
}

export interface RuntimeAccountsConfig {
  /** Accounts beyond the default; an entry with the default id only relabels it. */
  accounts?: RuntimeAccount[];
  /** Account that runs this runtime's sessions when a model names no account. */
  defaultAccountId?: string;
}

export type RuntimeAccountsSettings = Partial<Record<AccountRuntimeId, RuntimeAccountsConfig>>;

export interface RuntimeTarget {
  runtimeId: string;
  /** Absent for the default account; an explicit `default` pins it past a configured default. */
  accountId?: string;
}

export function isOriginalRuntimeAccount(accountId: string | undefined): boolean {
  return !accountId || accountId === DEFAULT_RUNTIME_ACCOUNT_ID;
}

export function isAccountRuntimeId(value: string): value is AccountRuntimeId {
  return (ACCOUNT_RUNTIME_IDS as readonly string[]).includes(value);
}

export function isRuntimeAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value);
}

/** A slug usable as an account id, derived from a user-facing label. */
export function runtimeAccountIdFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "account";
  let candidate = base;
  for (let suffix = 2; taken.has(candidate) || candidate === DEFAULT_RUNTIME_ACCOUNT_ID; suffix++) {
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

/** `claude` for the default account, `claude@work` for any other. */
export function runtimeTargetKey(target: RuntimeTarget): string {
  return isOriginalRuntimeAccount(target.accountId)
    ? target.runtimeId
    : `${target.runtimeId}${RUNTIME_ACCOUNT_SEPARATOR}${target.accountId}`;
}

/** Splits `claude` or `claude@work`; returns null for a malformed account id. */
export function parseRuntimeTargetKey(key: string): RuntimeTarget | null {
  const separator = key.indexOf(RUNTIME_ACCOUNT_SEPARATOR);
  if (separator < 0) return key.trim() ? { runtimeId: key.trim() } : null;
  const runtimeId = key.slice(0, separator).trim();
  const accountId = key.slice(separator + RUNTIME_ACCOUNT_SEPARATOR.length).trim();
  if (!runtimeId || !isRuntimeAccountId(accountId)) return null;
  return { runtimeId, accountId };
}

function normalizeAccount(raw: unknown): RuntimeAccount | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id: unknown = Reflect.get(raw, "id");
  if (!isRuntimeAccountId(id)) return null;
  const label: unknown = Reflect.get(raw, "label");
  const trimmed = typeof label === "string" ? label.trim().slice(0, MAX_ACCOUNT_LABEL_LENGTH) : "";
  return trimmed ? { id, label: trimmed } : { id };
}

/** Drops unknown runtimes, malformed or duplicate accounts, and defaults naming no account. */
export function normalizeRuntimeAccounts(raw: unknown): RuntimeAccountsSettings | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const settings: RuntimeAccountsSettings = {};
  for (const runtimeId of ACCOUNT_RUNTIME_IDS) {
    const entry: unknown = Reflect.get(raw, runtimeId);
    if (typeof entry !== "object" || entry === null) continue;
    const rawAccounts: unknown = Reflect.get(entry, "accounts");
    const seen = new Set<string>();
    const accounts: RuntimeAccount[] = [];
    for (const item of Array.isArray(rawAccounts) ? rawAccounts : []) {
      const account = normalizeAccount(item);
      if (!account || seen.has(account.id)) continue;
      seen.add(account.id);
      accounts.push(account);
    }
    const rawDefault: unknown = Reflect.get(entry, "defaultAccountId");
    const config: RuntimeAccountsConfig = {};
    if (accounts.length > 0) config.accounts = accounts;
    if (
      isRuntimeAccountId(rawDefault) &&
      rawDefault !== DEFAULT_RUNTIME_ACCOUNT_ID &&
      seen.has(rawDefault)
    ) {
      config.defaultAccountId = rawDefault;
    }
    if (config.accounts || config.defaultAccountId) settings[runtimeId] = config;
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Every account of a runtime, the default first. */
export function listRuntimeAccounts(
  settings: RuntimeAccountsSettings | undefined,
  runtimeId: string,
): RuntimeAccount[] {
  if (!isAccountRuntimeId(runtimeId)) return [{ id: DEFAULT_RUNTIME_ACCOUNT_ID }];
  const configured = settings?.[runtimeId]?.accounts ?? [];
  const defaultEntry = configured.find((account) => account.id === DEFAULT_RUNTIME_ACCOUNT_ID);
  return [
    defaultEntry ?? { id: DEFAULT_RUNTIME_ACCOUNT_ID },
    ...configured.filter((account) => account.id !== DEFAULT_RUNTIME_ACCOUNT_ID),
  ];
}

export function hasRuntimeAccount(
  settings: RuntimeAccountsSettings | undefined,
  target: RuntimeTarget,
): boolean {
  if (isOriginalRuntimeAccount(target.accountId)) return true;
  return listRuntimeAccounts(settings, target.runtimeId).some(
    (account) => account.id === target.accountId,
  );
}

/** The account plain models of this runtime run on; undefined means the default account. */
export function defaultRuntimeAccountId(
  settings: RuntimeAccountsSettings | undefined,
  runtimeId: string,
): string | undefined {
  if (!isAccountRuntimeId(runtimeId)) return undefined;
  const accountId = settings?.[runtimeId]?.defaultAccountId;
  return accountId && hasRuntimeAccount(settings, { runtimeId, accountId }) ? accountId : undefined;
}

export function runtimeAccountLabel(account: RuntimeAccount): string {
  return account.label ?? (account.id === DEFAULT_RUNTIME_ACCOUNT_ID ? "Primary" : account.id);
}
