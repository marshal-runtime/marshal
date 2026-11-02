/**
 * Stable cmdk `value` for an entity row. We use `entity.id` (which is
 * always populated and unique per entity in both the People and File
 * parsers) prefixed by `entity.type` to keep values unique across tabs.
 *
 * (We deliberately do NOT use `entity.referenceId` here — only File
 * entities populate it; People rows have referenceId=undefined, which
 * would collapse every People row to "People:undefined" and make cmdk
 * mark every row as data-selected="true".)
 */
import type { ContextEntity } from "@/types/electron";

export function entityValue(entity: ContextEntity): string {
  const { type, id } = entity;
  return `${type}:${id}`;
}
