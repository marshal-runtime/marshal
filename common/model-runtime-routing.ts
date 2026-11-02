import {
  RUNTIME_ACCOUNT_SEPARATOR,
  defaultRuntimeAccountId,
  parseRuntimeTargetKey,
  runtimeTargetKey,
  type RuntimeAccountsSettings,
} from "./runtime-accounts";
import { CLAUDE_RUNTIME_ID, CODEX_RUNTIME_ID, CURSOR_RUNTIME_ID } from "./runtime-config";
import {
  PEER_RUNTIME_IDS,
  RUNTIME_MODEL_SEPARATOR,
  formatRuntimeQualifiedModel,
  parseRuntimeQualifiedModel,
} from "./runtime-qualified-model";

export const MODEL_PROVIDER_FAMILIES = ["anthropic", "openai", "google"] as const;
export type ModelProviderFamily = (typeof MODEL_PROVIDER_FAMILIES)[number];

/** Runtimes a provider family may be routed to: the local runtimes that can run as peers. */
export const MODEL_ROUTING_RUNTIME_IDS = [
  CLAUDE_RUNTIME_ID,
  CODEX_RUNTIME_ID,
  CURSOR_RUNTIME_ID,
] as const;

/** A routing value: a peer runtime, optionally with an account (`claude@work`). */
export const MODEL_ROUTING_TARGET_PATTERN = /^(claude|codex|cursor)(@[a-z0-9][a-z0-9-]{0,31})?$/;

/** Which local runtime (and account) runs plain (unqualified) model ids of each provider family. */
export type ModelRuntimeRouting = Partial<Record<ModelProviderFamily, string>>;

const FAMILY_PATTERNS: ReadonlyArray<readonly [ModelProviderFamily, RegExp]> = [
  ["anthropic", /^(claude|opus|sonnet|haiku)/],
  ["openai", /^(gpt|o\d|codex)/],
  ["google", /^gemini/],
];

export function detectModelProviderFamily(
  model: string | undefined,
): ModelProviderFamily | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return undefined;
  return FAMILY_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0];
}

/** Keeps only known families routed to runtimes (and accounts) that can host peer sessions. */
export function normalizeModelRuntimeRouting(raw: unknown): ModelRuntimeRouting | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const routing: ModelRuntimeRouting = {};
  for (const family of MODEL_PROVIDER_FAMILIES) {
    const value: unknown = Reflect.get(raw, family);
    const target = typeof value === "string" ? parseRuntimeTargetKey(value) : null;
    if (target && PEER_RUNTIME_IDS.has(target.runtimeId)) {
      routing[family] = runtimeTargetKey(target);
    }
  }
  return Object.keys(routing).length > 0 ? routing : undefined;
}

/**
 * Maps a requested model id onto the runtime configured for its provider family.
 * Qualified ids, unknown families, unrouted families, and families routed to the
 * active runtime's default account come back unchanged; only a local peer-capable
 * active runtime can host a qualified model, so any other active runtime also
 * leaves ids alone.
 */
export function routeModelToRuntime(
  model: string,
  routing: ModelRuntimeRouting | undefined,
  activeRuntimeId: string,
): string {
  if (!routing || parseRuntimeQualifiedModel(model)) return model;
  if (!PEER_RUNTIME_IDS.has(activeRuntimeId)) return model;
  const family = detectModelProviderFamily(model);
  const targetKey = family ? routing[family] : undefined;
  if (!targetKey || targetKey === activeRuntimeId) return model;
  const target = parseRuntimeTargetKey(targetKey);
  if (!target || !PEER_RUNTIME_IDS.has(target.runtimeId)) return model;
  return `${runtimeTargetKey(target)}${RUNTIME_MODEL_SEPARATOR}${model.trim()}`;
}

/**
 * Pins a model that names no account to its runtime's configured default account:
 * `opus` on an active Claude runtime becomes `claude@work:opus`, and `codex:gpt-5`
 * becomes `codex@team:gpt-5`. Models already naming an account, and runtimes whose
 * default is the original account, are unchanged.
 */
export function applyDefaultRuntimeAccount(
  model: string,
  accounts: RuntimeAccountsSettings | undefined,
  activeRuntimeId: string,
): string {
  if (!accounts || !model.trim()) return model;
  const qualified = parseRuntimeQualifiedModel(model);
  if (qualified?.accountId) return model;
  const runtimeId = qualified?.runtimeId ?? activeRuntimeId;
  if (!PEER_RUNTIME_IDS.has(activeRuntimeId) || !PEER_RUNTIME_IDS.has(runtimeId)) return model;
  const accountId = defaultRuntimeAccountId(accounts, runtimeId);
  if (!accountId) return model;
  return formatRuntimeQualifiedModel({
    runtimeId,
    accountId,
    model: qualified?.model ?? model.trim(),
  });
}

/**
 * A plain model picked for a session keeps that session's account when it still runs on the
 * session's runtime: switching a `claude@work` chat to `sonnet` gives `claude@work:sonnet`,
 * not the default account, and a chat pinned to `claude@default` stays pinned. Explicitly
 * qualified requests are kept as routed.
 */
export function preserveSessionRuntimeAccount(args: {
  requestedModel: string;
  routedModel: string;
  sessionModel: string | undefined;
  activeRuntimeId: string;
}): string {
  const { requestedModel, routedModel, sessionModel, activeRuntimeId } = args;
  if (parseRuntimeQualifiedModel(requestedModel)) return routedModel;
  const session = parseRuntimeQualifiedModel(sessionModel);
  if (!session?.accountId) return routedModel;
  const routed = parseRuntimeQualifiedModel(routedModel);
  if ((routed?.runtimeId ?? activeRuntimeId) !== session.runtimeId) return routedModel;
  const target = `${session.runtimeId}${RUNTIME_ACCOUNT_SEPARATOR}${session.accountId}`;
  return `${target}${RUNTIME_MODEL_SEPARATOR}${routed?.model ?? routedModel.trim()}`;
}
