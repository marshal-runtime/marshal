export type MessageSegment =
  | { readonly kind: "markdown"; readonly key: string; readonly text: string }
  | { readonly kind: "slot"; readonly key: string; readonly name: string };

const SLOT_LINE = /^[ \t]*<!--[ \t]*ui:([A-Za-z0-9_-]{1,64})[ \t]*-->[ \t]*$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Splits message markdown at `<!--ui:name-->` placeholders that stand on
 * their own line outside code fences. Text without placeholders comes back as
 * a single markdown segment. Keys stay stable while a streaming message grows.
 */
export function splitMessageSlots(content: string): readonly MessageSegment[] {
  if (!content.includes("<!--")) return [{ kind: "markdown", key: "md-0", text: content }];
  const segments: MessageSegment[] = [];
  const slotCounts = new Map<string, number>();
  let markdownCount = 0;
  let buffer: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    const text = buffer.join("\n");
    if (text.trim()) segments.push({ kind: "markdown", key: `md-${markdownCount++}`, text });
    buffer = [];
  };
  for (const line of content.split("\n")) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      buffer.push(line);
      continue;
    }
    const slot = fence ? null : SLOT_LINE.exec(line);
    if (slot) {
      flush();
      const name = slot[1];
      const occurrence = slotCounts.get(name) ?? 0;
      slotCounts.set(name, occurrence + 1);
      segments.push({ kind: "slot", key: `slot-${name}-${occurrence}`, name });
    } else {
      buffer.push(line);
    }
  }
  flush();
  return segments.length > 0 ? segments : [{ kind: "markdown", key: "md-0", text: content }];
}
