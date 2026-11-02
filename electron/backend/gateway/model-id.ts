/**
 * One-way alias map for model ids on the way OUT to the Marshal gateway.
 *
 * Older Marshal installs saved Anthropic Opus model ids in their dotted
 * UI-alias form (``claude-opus-4.7``, ``claude-opus-4.6``) into per-session
 * metadata on disk and the global default-model setting. The gateway →
 * marshal adapter → Anthropic chain accepts only the canonical hyphenated
 * ids (``claude-opus-4-7``, ``claude-opus-4-6``); sending the dotted form
 * fails the agent run inside the runtime with
 * ``"LLM request timed out."`` and no model output.
 *
 * Applied at the gateway-backend boundary rather than rewriting persisted
 * state, so existing users self-heal without a disk migration step. The
 * dotted form stays usable on the Copilot path, which has its own server-
 * side aliasing for Anthropic ids.
 *
 * Sonnet's dotted form (``claude-sonnet-4.6``) is aliased server-side
 * already, so only the Opus pair needs translation. Add new entries here
 * if other model ids surface in the dotted form on the wire.
 */
const GATEWAY_MODEL_ID_ALIASES: Record<string, string> = {
  "claude-opus-4.7": "claude-opus-4-7",
  "claude-opus-4.6": "claude-opus-4-6",
};

/**
 * Translate a (possibly legacy) model id to the form the Marshal gateway
 * expects on the wire. Pass-through for ids not in the map and for
 * `undefined` / empty (so callers can pipe `opts.model` through directly).
 */
export function normalizeGatewayModelId(id: string | undefined): string | undefined {
  if (!id) return id;
  return GATEWAY_MODEL_ID_ALIASES[id] ?? id;
}

/**
 * Models the Marshal gateway is known to route end-to-end. Anthropic ids
 * go through the marshal adapter to Anthropic; others (gpt-*, gemini-*)
 * are not supported on the gateway path today and produce silent LLM
 * timeouts when selected, which is the worst possible UX. Listing them
 * here lets us reject early at create() with a message that points at the
 * actually-supported set.
 *
 * Both the canonical hyphenated id AND the historical dotted form are
 * listed where they're known to be aliased server-side (sonnet) or
 * normalized at the boundary (opus, via GATEWAY_MODEL_ID_ALIASES above).
 */
const GATEWAY_SUPPORTED_MODEL_IDS = new Set<string>([
  "claude-opus-4-7",
  "claude-opus-4-6",
  // Dotted opus forms are translated by normalizeGatewayModelId, but list
  // them as supported so isGatewaySupportedModel(originalId) returns true
  // without callers having to normalize first.
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-sonnet-4-6",
  "claude-sonnet-4.6",
  "claude-haiku-4-5-20251001",
]);

/**
 * Sorted list of canonical model ids the user should pick from. Used as
 * the suggestion text in `GatewayUnsupportedModelError`. Skips the dotted
 * legacy aliases — we want to nudge users toward the hyphenated form.
 */
export const GATEWAY_SUPPORTED_MODEL_SUGGESTIONS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;

/**
 * Returns true if `id` is something the Marshal gateway can route. An
 * `undefined` model is treated as supported — it lets the gateway pick
 * its own default, which is always something it can run.
 */
export function isGatewaySupportedModel(id: string | undefined): boolean {
  if (!id) return true;
  return GATEWAY_SUPPORTED_MODEL_IDS.has(id);
}

/**
 * Thrown when `GatewayBackend.create()` is called with a model the gateway
 * can't route. Gives the user a concrete suggestion list rather than the
 * silent "LLM request timed out" they'd otherwise hit downstream.
 */
export class GatewayUnsupportedModelError extends Error {
  readonly name = "GatewayUnsupportedModelError";
  constructor(
    readonly modelId: string,
    readonly supportedIds: ReadonlyArray<string> = GATEWAY_SUPPORTED_MODEL_SUGGESTIONS,
  ) {
    super(
      `Model "${modelId}" is not supported on the Marshal gateway. ` +
        `Pick one of: ${supportedIds.join(", ")}.`,
    );
  }
}
