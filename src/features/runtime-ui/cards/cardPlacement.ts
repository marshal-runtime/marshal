import type { RuntimeUiInstance } from "@common/runtime-ui";

import type { TimelineMessageRef } from "./conversationCardStore";

export interface ConversationCardPlacement {
  /** Cards shown right after a committed message, keyed by message id. */
  readonly afterMessage: ReadonlyMap<string, readonly RuntimeUiInstance[]>;
  /** Cards newer than every committed message: shown after the live turn. */
  readonly trailing: readonly RuntimeUiInstance[];
}

/** Permanent cards: inline-card views that are not transient. */
export function isConversationCard(instance: RuntimeUiInstance): boolean {
  return instance.surface === "inline-card" && !instance.transient;
}

/**
 * Places permanent cards in the conversation. An explicit `afterMessageId`
 * wins; otherwise a card sits after the last message committed before it
 * opened, so it stays in the turn that produced it. Cards whose slot is
 * rendered inside a message are left to that message. While a turn is live, a
 * new slot card whose marker is not on screen yet stays hidden: the agent may
 * open the view first and write `<!--ui:name-->` in its reply afterwards.
 */
export function placeConversationCards(
  cards: readonly RuntimeUiInstance[],
  messages: readonly TimelineMessageRef[],
  mountedSlots: ReadonlySet<string>,
  turnLive = false,
): ConversationCardPlacement {
  const afterMessage = new Map<string, RuntimeUiInstance[]>();
  const trailing: RuntimeUiInstance[] = [];
  const known = new Set(messages.map((message) => message.id));
  const last = messages.at(-1);
  const ordered = [...cards].sort((left, right) => left.openedAt.localeCompare(right.openedAt));
  for (const card of ordered) {
    if (card.anchor?.slot && mountedSlots.has(card.anchor.slot)) continue;
    const explicit = card.anchor?.afterMessageId;
    let anchorId = explicit && known.has(explicit) ? explicit : undefined;
    if (!anchorId) {
      const opened = Date.parse(card.openedAt);
      const before = lastMessageAtOrBefore(messages, opened);
      // Older than every loaded message: keep it at the top of what is loaded.
      anchorId = before ? before.id : messages[0]?.id;
      if (before && before.id === last?.id) anchorId = undefined;
    }
    if (!anchorId) {
      if (turnLive && card.anchor?.slot) continue;
      trailing.push(card);
      continue;
    }
    const list = afterMessage.get(anchorId);
    if (list) list.push(card);
    else afterMessage.set(anchorId, [card]);
  }
  return { afterMessage, trailing };
}

function lastMessageAtOrBefore(
  messages: readonly TimelineMessageRef[],
  at: number,
): TimelineMessageRef | undefined {
  let found: TimelineMessageRef | undefined;
  for (const message of messages) {
    if (message.at <= at) found = message;
    else break;
  }
  return found;
}
