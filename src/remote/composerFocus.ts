const COLLAPSIBLE = "[data-mobile-collapsible]";
const OPEN_ATTRIBUTE = "data-composer-open";
// Longer than the gap between touchend and the click WebKit synthesizes from it.
const COLLAPSE_DELAY_MS = 350;

/**
 * The phone composer folds to a reply line when it loses focus. Folding the
 * instant focus leaves would shift the chat between a tap's touchend and its
 * click, so the click lands beside the button the finger hit. Folding waits
 * until the tap has landed.
 */
export function installComposerFocus() {
  let timer = 0;
  const composerOf = (target: EventTarget | null) =>
    target instanceof Element ? target.closest(COLLAPSIBLE) : null;
  const onFocusIn = (event: FocusEvent) => {
    const composer = composerOf(event.target);
    if (!composer) return;
    window.clearTimeout(timer);
    composer.setAttribute(OPEN_ATTRIBUTE, "");
  };
  const onFocusOut = (event: FocusEvent) => {
    const composer = composerOf(event.target);
    if (!composer || composer.contains(composerOf(event.relatedTarget))) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!composer.contains(document.activeElement)) composer.removeAttribute(OPEN_ATTRIBUTE);
    }, COLLAPSE_DELAY_MS);
  };
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  return () => {
    window.clearTimeout(timer);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
  };
}
