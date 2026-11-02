function isPlainTextElement(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;

  if (target instanceof HTMLInputElement) {
    const type = target.type.toLowerCase();
    return type !== "button" && type !== "submit" && type !== "reset";
  }

  return false;
}

function isContentEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const editableAncestor = target.closest<HTMLElement>("[contenteditable]");
  return editableAncestor !== null && editableAncestor.contentEditable.toLowerCase() !== "false";
}

export function isPlainTextHotkeyTarget(event: KeyboardEvent): boolean {
  if (isPlainTextElement(document.activeElement)) return true;
  // composedPath() pierces shadow roots where activeElement can report only the host.
  if (event.composedPath().some(isPlainTextElement)) return true;
  return false;
}

export function isEditableHotkeyTarget(event: KeyboardEvent): boolean {
  if (
    isPlainTextElement(document.activeElement) ||
    isContentEditableElement(document.activeElement)
  ) {
    return true;
  }
  return event
    .composedPath()
    .some((target) => isPlainTextElement(target) || isContentEditableElement(target));
}

const ACTIVE_OVERLAY_SELECTOR =
  '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [aria-modal="true"]';

export function isHotkeyOwnedByActiveOverlay(event: KeyboardEvent): boolean {
  const active = document.activeElement;
  if (active instanceof Element && active.closest(ACTIVE_OVERLAY_SELECTOR)) return true;
  if (
    event
      .composedPath()
      .some(
        (target) => target instanceof Element && target.closest(ACTIVE_OVERLAY_SELECTOR) !== null,
      )
  ) {
    return true;
  }
  return document.querySelector(ACTIVE_OVERLAY_SELECTOR) !== null;
}
