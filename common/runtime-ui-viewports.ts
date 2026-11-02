/**
 * Which client viewports a runtime-UI surface serves. The declaration lives on
 * the EXISTING runtime contracts — the published application's `metadata`
 * record (RuntimeExtensionUiApplication.metadata, key below) and, for
 * agent-authored components, a `viewports` member on the compiled-payload
 * marshal record — never in the document markup.
 *
 * HTML meta detection is deliberately NOT a signal: the runtime stamps
 * `<meta name="viewport" content="width=device-width,…">` on every compiled
 * artifact wrapper (agent-runtime-ui compiler.ts, runtimeRenderer.ts,
 * declarative/renderer.ts), so document metas carry zero evidence of a
 * deliberate mobile view. Presence-based means deliberate presence:
 * undeclared surfaces are desktop-only.
 */
export type MarshalUiViewport = "mobile" | "desktop";

/** Documented metadata key on RuntimeExtensionUiApplication.metadata. */
export const MARSHAL_UI_VIEWPORTS_METADATA_KEY = "marshal.ui.viewports";

/**
 * Agent-authored renders have no metadata record (the runtime's ui.render
 * manifest validator strips unknown fields), so they declare viewports in a
 * reserved render prop. The declaration persists with the render in the
 * runtime store and is agent-authored either way.
 */
export const AUTHORED_UI_VIEWPORTS_PROP = "marshalViewports";

/** Host-injected prop telling an authored component which client is viewing it. */
export const AUTHORED_UI_CLIENT_VIEWPORT_PROP = "marshalViewport";

export const DESKTOP_ONLY_VIEWPORTS: ReadonlySet<MarshalUiViewport> = Object.freeze(
  new Set<MarshalUiViewport>(["desktop"]),
);

/**
 * Parse a viewport declaration value: an array of strings or a single
 * whitespace/comma-separated string; tokens are case-insensitive; only
 * `mobile` and `desktop` are recognized and unknown tokens are ignored.
 *
 * Returns null when the value is absent or not a recognizable shape
 * (= UNDECLARED, which callers treat as desktop-only). A declaration that is
 * present but yields no recognized token also resolves to desktop-only — an
 * explicit declaration never widens by accident.
 */
export function parseUiViewports(value: unknown): ReadonlySet<MarshalUiViewport> | null {
  const tokens: string[] = [];
  if (typeof value === "string") tokens.push(...value.split(/[\s,]+/));
  else if (Array.isArray(value)) {
    for (const entry of value) if (typeof entry === "string") tokens.push(entry);
  } else return null;
  const declared = new Set<MarshalUiViewport>();
  for (const token of tokens) {
    const normalized = token.trim().toLowerCase();
    if (normalized === "mobile" || normalized === "desktop") declared.add(normalized);
  }
  return declared.size > 0 ? declared : DESKTOP_ONLY_VIEWPORTS;
}

/**
 * Resolve the declared viewports from a publication/artifact metadata record.
 * Returns null when the record carries no declaration (undeclared surface:
 * not listed on mobile; session-owned renders gate to desktop-only).
 */
export function declaredUiViewportsFromMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): ReadonlySet<MarshalUiViewport> | null {
  if (!metadata) return null;
  return parseUiViewports(metadata[MARSHAL_UI_VIEWPORTS_METADATA_KEY]);
}
