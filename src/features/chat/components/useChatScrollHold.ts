import { useCallback, useEffect, useRef, type WheelEvent } from "react";

import { setTranscriptHeld } from "../state/messageWindow";

const RETURN_TO_BOTTOM_PX = 16;

interface ScrollPosition {
  scrollTop: number;
  scrollHeight: number;
}

function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function isVerticalScroller(element: Element): boolean {
  const { overflowY } = getComputedStyle(element);
  return (
    (overflowY === "auto" || overflowY === "scroll") && element.scrollHeight > element.clientHeight
  );
}

function wheelTargetsContainer(target: EventTarget, container: HTMLElement): boolean {
  let element = target instanceof Element ? target : null;
  while (element && element !== container) {
    if (isVerticalScroller(element)) return false;
    element = element.parentElement;
  }
  return element === container;
}

export interface ChatScrollHold {
  /** `useStickToBottom` option: while held, the bottom is wherever the reader already is. */
  targetScrollTop: (bottom: number, context: { scrollElement: HTMLElement }) => number;
  /** Both handlers return true when the reader came back to the bottom and following should resume. */
  handleScroll: (element: HTMLElement) => boolean;
  handleWheel: (
    event: Pick<WheelEvent<HTMLElement>, "currentTarget" | "target" | "deltaY">,
  ) => boolean;
  release: () => void;
}

/**
 * Keeps a reader who scrolled up exactly where they are until they scroll back
 * to the bottom or send a message themselves.
 *
 * `use-stick-to-bottom` alone cannot promise this: any shrink of the content
 * while the reader is within 70px of the bottom re-locks them, and scroll events
 * during a resize are ignored. Layout changes are told apart from the reader by
 * `scrollHeight`: only a scroll that leaves it unchanged counts as theirs.
 */
export function useChatScrollHold(sessionId: string | null): ChatScrollHold {
  const heldRef = useRef(false);
  const lastPositionRef = useRef<ScrollPosition | null>(null);

  const setHeld = useCallback(
    (held: boolean) => {
      heldRef.current = held;
      if (sessionId) setTranscriptHeld(sessionId, held);
    },
    [sessionId],
  );

  useEffect(
    () => () => {
      heldRef.current = false;
      lastPositionRef.current = null;
      if (sessionId) setTranscriptHeld(sessionId, false);
    },
    [sessionId],
  );

  const targetScrollTop = useCallback<ChatScrollHold["targetScrollTop"]>(
    (bottom, { scrollElement }) => (heldRef.current ? scrollElement.scrollTop : bottom),
    [],
  );

  const handleScroll = useCallback(
    (element: HTMLElement) => {
      const { scrollTop, scrollHeight } = element;
      const previous = lastPositionRef.current;
      lastPositionRef.current = { scrollTop, scrollHeight };
      if (!previous || previous.scrollHeight !== scrollHeight) return false;
      if (scrollTop < previous.scrollTop) {
        setHeld(true);
        return false;
      }
      if (
        heldRef.current &&
        scrollTop > previous.scrollTop &&
        distanceFromBottom(element) <= RETURN_TO_BOTTOM_PX
      ) {
        setHeld(false);
        return true;
      }
      return false;
    },
    [setHeld],
  );

  const handleWheel = useCallback(
    ({ currentTarget, target, deltaY }: Parameters<ChatScrollHold["handleWheel"]>[0]) => {
      if (currentTarget.scrollHeight <= currentTarget.clientHeight) return false;
      if (!wheelTargetsContainer(target, currentTarget)) return false;
      if (deltaY < 0) {
        setHeld(true);
        return false;
      }
      if (
        heldRef.current &&
        deltaY > 0 &&
        distanceFromBottom(currentTarget) <= RETURN_TO_BOTTOM_PX
      ) {
        setHeld(false);
        return true;
      }
      return false;
    },
    [setHeld],
  );

  const release = useCallback(() => setHeld(false), [setHeld]);

  return { targetScrollTop, handleScroll, handleWheel, release };
}
