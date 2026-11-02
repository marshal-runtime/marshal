import type { RuntimeUiInstance } from "@common/runtime-ui";
import { use, useMemo } from "react";

import { cn } from "@/lib/marshal-class-names";

import { RuntimeUiContext } from "../runtimeUiContext";
import {
  isConversationCard,
  placeConversationCards,
  type ConversationCardPlacement,
} from "./cardPlacement";
import {
  useConversationCardSnapshot,
  useRegisterLiveTurn,
  useRegisterSlot,
} from "./conversationCardStore";
import { RuntimeUiCard } from "./RuntimeUiCard";

const EMPTY: readonly RuntimeUiInstance[] = [];

function useConversationPlacement(): ConversationCardPlacement {
  const model = use(RuntimeUiContext);
  const { messages, mountedSlots, turnLive } = useConversationCardSnapshot();
  const cards = model?.bySurface["inline-card"] ?? EMPTY;
  return useMemo(
    () =>
      placeConversationCards(cards.filter(isConversationCard), messages, mountedSlots, turnLive),
    [cards, messages, mountedSlots, turnLive],
  );
}

function CardList({
  cards,
  testId,
}: {
  readonly cards: readonly RuntimeUiInstance[];
  readonly testId: string;
}) {
  if (cards.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-3" data-testid={testId}>
      {cards.map((card) => (
        <RuntimeUiCard key={card.instanceId} instance={card} variant="card" />
      ))}
    </div>
  );
}

/** Permanent cards anchored after any of these committed messages. */
export function RuntimeUiMessageCards({ messageIds }: { readonly messageIds: readonly string[] }) {
  const { afterMessage } = useConversationPlacement();
  const cards = messageIds.flatMap((id) => afterMessage.get(id) ?? EMPTY);
  if (cards.length === 0) return null;
  return (
    <div className="mt-4">
      <CardList cards={cards} testId="runtime-ui-message-cards" />
    </div>
  );
}

/** Permanent cards newer than every committed message, shown after the live turn. */
export function RuntimeUiTrailingCards() {
  const { trailing } = useConversationPlacement();
  if (trailing.length === 0) return null;
  return (
    <div className="mx-auto mb-6 w-full max-w-3xl shrink-0">
      <CardList cards={trailing} testId="runtime-ui-trailing-cards" />
    </div>
  );
}

/**
 * Transient cards (sign-in, API keys, confirmations) float above the chat and
 * never enter the transcript. They leave when the extension completes or
 * cancels them, when the user closes them, or when they expire.
 */
export function RuntimeUiTransientCards({ className }: { readonly className?: string }) {
  const model = use(RuntimeUiContext);
  const cards = (model?.bySurface["inline-card"] ?? EMPTY).filter((card) => card.transient);
  if (cards.length === 0) return null;
  return (
    <div
      className={cn("pointer-events-none flex flex-col gap-2", className)}
      role="region"
      aria-label="Temporary cards"
      data-testid="runtime-ui-transient-cards"
    >
      {cards.map((card) => (
        <div key={card.instanceId} className="pointer-events-auto">
          <RuntimeUiCard instance={card} variant="transient" />
        </div>
      ))}
    </div>
  );
}

/** Rendered by the live turn so slot cards can wait for the reply that places them. */
export function RuntimeUiLiveTurn() {
  useRegisterLiveTurn();
  return null;
}

/**
 * Renders the view bound to `<!--ui:name-->` inside a message. While the
 * turn is live and nothing is bound yet it holds the space with a skeleton;
 * once the turn ends an unbound slot renders nothing.
 */
export function RuntimeUiMessageSlot({
  name,
  live,
}: {
  readonly name: string;
  readonly live: boolean;
}) {
  const model = use(RuntimeUiContext);
  useRegisterSlot(name);
  const bound = (model?.bySurface["inline-card"] ?? EMPTY).find(
    (card) => !card.transient && card.anchor?.slot === name,
  );
  if (bound) {
    return (
      <div className="my-3" data-ui-slot={name}>
        <RuntimeUiCard instance={bound} variant="slot" />
      </div>
    );
  }
  if (!live) return null;
  return (
    <div
      className="my-3 h-24 animate-pulse rounded-xl border border-dashed border-border bg-muted/40"
      data-ui-slot={name}
      data-testid="runtime-ui-slot-pending"
      aria-hidden="true"
    />
  );
}
