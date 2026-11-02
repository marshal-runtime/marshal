/**
 * Wrap external (untrusted) content in <external_content> tags before it enters
 * the model context. The model's system prompt instructs it to treat anything
 * inside these tags as data — never as instructions.
 *
 * This is the application-layer half of the OWASP LLM01 (Indirect Prompt
 * Injection) defense. The other half is the standing system-prompt directive
 * in system-message.ts ("## External Content & Untrusted Input").
 *
 * Constraints (what this helper does NOT promise):
 *  - It is a deterministic envelope, not a probabilistic shield. The model may
 *    still occasionally honor an injection — defense-in-depth (permission gates,
 *    confirmation prompts, autonomy budget) is the rest of the answer.
 *  - The closing-tag escape defends against the most common breakout vectors
 *    (exact, case, whitespace, and attribute-bearing closing tags). It does NOT
 *    claim to defeat all unicode-normalization or token-encoding attacks.
 */

import { makeClosingTagEscaper } from "./foundation/prompt/prompt-boundary";

export const EXTERNAL_CONTENT_TAG = "external_content";
const escapeExternalContentClosingTag = makeClosingTagEscaper(EXTERNAL_CONTENT_TAG);

export type UntrustedSource = "mcp" | "whatsapp_relay";

export interface WrapOpts {
  /**
   * Opaque relay-transport sender identifier (e.g. a WhatsApp JID) for relay
   * sources. This is not an account or directory identifier.
   */
  senderId?: string;
}

const MAX_SENDER_ID_ATTR_LENGTH = 200;

function sanitizeSenderIdAttr(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      char === "<" ||
      char === ">" ||
      char === `"` ||
      char === "&"
    ) {
      continue;
    }
    result += char;
    if (result.length >= MAX_SENDER_ID_ATTR_LENGTH) break;
  }
  return result;
}

/**
 * Wrap a string in `<external_content source="...">` tags, escaping any
 * embedded closing-tag variants in the body so the wrap cannot be broken out of.
 *
 * @param source - Provenance label drawn from the closed UntrustedSource union.
 * @param body   - The raw external content. Empty bodies intentionally wrap to
 *                 an empty envelope: callers can rely on "external input is
 *                 always wrapped" without special-casing blanks.
 * @param opts.senderId - Optional opaque relay sender id; sanitized for use as
 *                        a model-visible XML-like attribute.
 * @returns Wrapped string, ready to be returned to the SDK as a tool result.
 */
export function wrapUntrusted(source: UntrustedSource, body: string, opts: WrapOpts = {}): string {
  const safe = escapeExternalContentClosingTag(body);

  let attrs = `source="${source}"`;
  if (opts.senderId !== undefined) {
    const senderId = sanitizeSenderIdAttr(opts.senderId);
    if (senderId) {
      attrs += ` sender_id="${senderId}"`;
    }
  }
  return `<${EXTERNAL_CONTENT_TAG} ${attrs}>\n${safe}\n</${EXTERNAL_CONTENT_TAG}>`;
}
